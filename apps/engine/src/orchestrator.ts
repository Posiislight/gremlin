import { Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agentRuns, charters, environments, scans, type Db } from '@gremlin/db';
import type { AgentJob } from './persist.js';
import { connectionFromUrl, type Queues } from './queue.js';

export const DiscoveryJobData = z.object({ scanId: z.string().min(1), startPath: z.string().startsWith('/').optional() });

/** Persist the entire team before publishing jobs, so the first agent cannot finish a half-created scan. */
export async function discoverScan(deps: { db: Db; queues: Queues }, data: z.infer<typeof DiscoveryJobData>): Promise<void> {
  const jobs = await deps.db.transaction(async (tx): Promise<AgentJob[]> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${data.scanId}))`);
    const [ctx] = await tx.select({ scan: scans, env: environments }).from(scans)
      .innerJoin(environments, eq(scans.environmentId, environments.id)).where(eq(scans.id, data.scanId));
    if (!ctx) throw new Error('scan_not_found');
    if (ctx.scan.finishedAt) return [];
    let rows = await tx.select({ run: agentRuns, charter: charters }).from(agentRuns)
      .innerJoin(charters, eq(agentRuns.charterId, charters.id)).where(eq(agentRuns.scanId, data.scanId));
    if (!rows.length) {
      for (let i = 0; i < ctx.scan.teamSize; i++) {
        const [charter] = await tx.insert(charters).values({ scanId: data.scanId, type: 'happy_path',
          area: `agent-${i + 1}`, goal: ctx.scan.focus ?? 'Explore this app, exercise its main flows and report reproducible bugs.',
          startPath: data.startPath ?? '/', viewport: 'desktop' }).returning();
        const [run] = await tx.insert(agentRuns).values({ scanId: data.scanId, charterId: charter!.id, kind: 'scan', status: 'queued' }).returning();
        rows.push({ run: run!, charter: charter! });
      }
      await tx.update(scans).set({ status: 'scanning', startedAt: new Date() }).where(eq(scans.id, data.scanId));
    }
    return rows.filter(({ run }) => run.status === 'queued').map(({ run, charter }) => ({ scanId: data.scanId, runId: run.id,
      charter: { id: charter.id, type: 'happy_path', area: charter.area ?? 'explore', goal: charter.goal,
        startPath: charter.startPath ?? '/', risk: 1, viewport: 'desktop' } }));
  });
  for (const job of jobs) await deps.queues.agent.add('scan', job, { jobId: job.runId });
}

/** Lock the scan while checking its entire team; concurrent completions produce one terminal result. */
export async function finalizeScan(db: Db, scanId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scanId}))`);
    const runs = await tx.select().from(agentRuns).where(and(eq(agentRuns.scanId, scanId), eq(agentRuns.kind, 'scan')));
    if (!runs.length || runs.some((r) => r.status === 'queued' || r.status === 'running')) return;
    const errors = runs.filter((r) => r.status === 'error').length;
    await tx.update(scans).set({ status: errors === runs.length ? 'failed' : errors ? 'partial' : 'done', finishedAt: new Date() })
      .where(eq(scans.id, scanId));
  });
}

export async function startDiscoveryWorker(deps: { db: Db; queues: Queues; redisUrl: string; prefix?: string }) {
  const worker = new Worker('discovery', async (job) => {
    const data = DiscoveryJobData.parse(job.data);
    try { await discoverScan(deps, data); }
    catch (error) {
      await deps.db.update(scans).set({ status: 'failed', finishedAt: new Date() }).where(eq(scans.id, data.scanId));
      // Do not leave undispatched team members queued forever on a failed fan-out.
      await deps.db.update(agentRuns).set({ status: 'error', error: 'Scan dispatch failed' })
        .where(and(eq(agentRuns.scanId, data.scanId), eq(agentRuns.status, 'queued')));
      throw error;
    }
  }, { connection: connectionFromUrl(deps.redisUrl), ...(deps.prefix ? { prefix: deps.prefix } : {}) });
  worker.on('error', (error) => console.error('[discovery]', error));
  worker.on('failed', (job, error) => console.error(`[discovery] ${job?.id}: ${error.message}`));
  await worker.waitUntilReady();
  return worker;
}

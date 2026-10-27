/**
 * pnpm --filter @gremlin/engine scan:one <url> "<goal>" [--persona name] [--full]
 *
 * Creates project/environment/scan/charter/run rows, runs one agent inline (processAgentJob) against <url>,
 * and prints the findings, the timeline signed URL, navigator latency p50/p95 and token/cost totals.
 * Credentials come only from the environment (SCAN_USERNAME / SCAN_PASSWORD -> {{username}} / {{password}}).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import { chromium } from 'playwright';
import type { Charter } from '@gremlin/contract';
import {
  agentRuns,
  charters,
  createDb,
  environments,
  findingOccurrences,
  findings,
  llmUsage,
  migrate,
  projects,
  scans,
} from '@gremlin/db';
import { createLlm, loadLlmConfig } from '@gremlin/llm';
import { createStorage } from '@gremlin/storage';
import { createUsageSink, processAgentJob } from '../persist.js';

/** Repo-root .env fills in variables that are not already set (never overrides the shell). */
function loadDotEnv(): void {
  const path = resolve(import.meta.dirname, '../../../../.env');
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) process.env[k] ??= v;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

async function main(): Promise<number> {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { persona: { type: 'string' }, full: { type: 'boolean', default: false } },
  });
  const [target, goal] = positionals;
  if (!target || !goal) {
    console.error('usage: scan:one <url> "<goal>" [--persona name] [--full]');
    return 2;
  }
  const u = new URL(target);
  if (!/^https?:$/.test(u.protocol)) throw new Error('url must be http(s)');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');

  const secrets: Record<string, string> = {};
  if (process.env.SCAN_USERNAME) secrets.username = process.env.SCAN_USERNAME;
  if (process.env.SCAN_PASSWORD) secrets.password = process.env.SCAN_PASSWORD;
  const allowedActions = values.full ? 'full' : 'read_only';

  const db = createDb(databaseUrl);
  await migrate(db);
  const storage = createStorage(process.env);
  const llm = createLlm(loadLlmConfig(process.env), { onUsage: createUsageSink(db) });
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });

  try {
    // One project per origin, so re-running scan-one dedupes into occurrences.
    const name = `scan-one ${u.origin}`;
    const project =
      (await db.select().from(projects).where(eq(projects.name, name)).limit(1))[0] ??
      (await db.insert(projects).values({ name }).returning())[0]!;
    const env =
      (
        await db
          .select()
          .from(environments)
          .where(and(eq(environments.projectId, project.id), eq(environments.baseUrl, u.origin)))
          .limit(1)
      )[0] ??
      (await db.insert(environments).values({ projectId: project.id, baseUrl: u.origin, allowedActions }).returning())[0]!;
    const [scan] = await db
      .insert(scans)
      .values({ environmentId: env.id, status: 'scanning', teamSize: 1, allowedActions, startedAt: new Date() })
      .returning();
    const startPath = `${u.pathname}${u.search}` || '/';
    const [charterRow] = await db
      .insert(charters)
      .values({ scanId: scan!.id, type: 'happy_path', area: 'adhoc', goal, startPath, viewport: 'desktop' })
      .returning();
    const charter: Charter = {
      id: charterRow!.id,
      area: 'adhoc',
      goal,
      type: 'happy_path',
      startPath,
      risk: 1,
      viewport: 'desktop',
      ...(values.persona ? { persona: values.persona } : {}),
    };
    const [run] = await db
      .insert(agentRuns)
      .values({ scanId: scan!.id, charterId: charter.id, kind: 'scan', status: 'queued' })
      .returning();
    const runId = run!.id;

    console.log(`scan ${scan!.id} run ${runId}: ${u.href} (${allowedActions})`);
    let failed = false;
    const started = Date.now();
    try {
      await processAgentJob(
        {
          db,
          storage,
          llm,
          browser,
          secrets,
          onEvent: (e) => {
            if (e.type === 'step') console.log(`  #${e.step.n} ${e.step.action.type} ${e.step.intent} -> ${e.step.outcome}`);
            if (e.type === 'candidate') console.log(`  candidate ${e.candidate.oracle} ${e.candidate.severity}: ${e.candidate.message.slice(0, 120)}`);
          },
        },
        { scanId: scan!.id, runId, charter },
      );
    } catch (e) {
      failed = true;
      console.error(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await db
      .update(scans)
      .set({ status: failed ? 'failed' : 'done', finishedAt: new Date() })
      .where(eq(scans.id, scan!.id));

    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    console.log(`\nstatus: ${r?.status}${r?.error ? ` (${r.error})` : ''}  wall: ${((Date.now() - started) / 1000).toFixed(1)}s`);

    const occ = await db
      .select({ findingId: findingOccurrences.findingId })
      .from(findingOccurrences)
      .where(eq(findingOccurrences.agentRunId, runId));
    const ids = [...new Set(occ.map((o) => o.findingId))];
    const fs = ids.length ? await db.select().from(findings).where(inArray(findings.id, ids)) : [];
    console.log(`\nfindings (${fs.length}):`);
    for (const f of fs.sort((a, b) => a.priority.localeCompare(b.priority))) {
      const flag = f.unjudged ? ' [unjudged]' : '';
      console.log(`  ${f.priority} ${f.status}${flag} ${f.oracle ?? '?'}  ${f.title}\n      signature ${f.signature}`);
    }

    if (r?.timelineKey) console.log(`\ntimeline: ${await storage.signedUrl(r.timelineKey, 3600)}`);

    const usage = await db.select().from(llmUsage).where(eq(llmUsage.agentRunId, runId));
    const nav = usage.filter((x) => x.role === 'navigator').map((x) => x.latencyMs);
    const tokensIn = usage.reduce((s, x) => s + x.tokensIn, 0);
    const tokensOut = usage.reduce((s, x) => s + x.tokensOut, 0);
    const cost = usage.reduce((s, x) => s + x.costUsd, 0);
    console.log(
      `\nnavigator latency: p50 ${percentile(nav, 50)} ms, p95 ${percentile(nav, 95)} ms over ${nav.length} calls` +
        `\nllm calls: ${usage.length}  tokens: ${tokensIn} in / ${tokensOut} out  cost: $${cost.toFixed(4)}`,
    );
    return failed || r?.status === 'error' ? 1 : 0;
  } finally {
    await browser.close().catch(() => undefined);
    await db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

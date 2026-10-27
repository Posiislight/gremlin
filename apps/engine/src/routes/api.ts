import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ListFindingsQuery,
  PatchFindingBody,
  ReplayTimeline,
  type ApiFindingDetail,
  type ApiRun,
  type ApiScanDetail,
  type ApiTimeline,
} from '@gremlin/contract';
import { agentRuns, charters, findingOccurrences, findings, llmUsage, noise, projects, steps, type Db } from '@gremlin/db';
import type { Storage } from '@gremlin/storage';
import { authenticate } from '../auth.js';
import { signFilePath } from './files.js';
import { ownedFinding, ownedRun, ownedScan } from './access.js';
import { runSummary, summarizeFindings } from './serialize.js';

const idParam = z.object({ id: z.string().min(1).max(128) });
const segmentParam = z.object({ id: z.string().min(1).max(128), segment: z.coerce.number().int().min(0) });

const bad = (reply: FastifyReply, issues: unknown[]) => reply.code(400).send({ error: 'invalid_request', issues });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

export function apiRoutes(deps: { db: Db; storage: Storage; secret: string }) {
  const { db, storage, secret } = deps;
  const sign = (key: string | null | undefined): string | null => (key ? signFilePath(key, secret) : null);

  async function findingDetail(f: typeof findings.$inferSelect): Promise<ApiFindingDetail> {
    const [summary] = await summarizeFindings(db, [f]);
    const occ = await db
      .select({ occ: findingOccurrences, step: steps })
      .from(findingOccurrences)
      .innerJoin(steps, eq(steps.id, findingOccurrences.stepId))
      .where(eq(findingOccurrences.findingId, f.id))
      .orderBy(asc(steps.tMs));
    const occurrences = occ.map(({ occ: o, step }) => ({
      runId: o.agentRunId,
      stepId: o.stepId,
      stepN: step.n,
      tMs: step.tMs,
      intent: step.intent,
      screenshotUrl: sign(step.screenshotKey),
    }));
    return {
      ...summary!,
      verdict: (f.verdictJson ?? null) as ApiFindingDetail['verdict'],
      confirm: f.confirmJson ?? null,
      promptVariant: f.promptVariant,
      occurrences,
      screenshotUrls: [...new Set(occurrences.map((o) => o.screenshotUrl).filter((u): u is string => !!u))],
    };
  }

  async function loadTimeline(run: typeof agentRuns.$inferSelect): Promise<ReplayTimeline | null> {
    if (!run.timelineKey) return null;
    try {
      const raw = JSON.parse((await storage.get(run.timelineKey)).toString('utf8'));
      const parsed = ReplayTimeline.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return async function (app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticate(db));

    app.get('/v1/projects', async (req) => {
      const rows = await db.select().from(projects).where(eq(projects.id, req.projectId));
      return { projects: rows.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString() })) };
    });

    app.get('/v1/projects/:id/findings', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      const q = ListFindingsQuery.safeParse(req.query);
      if (!p.success) return bad(reply, p.error.issues);
      if (!q.success) return bad(reply, q.error.issues);
      if (p.data.id !== req.projectId) return notFound(reply);
      const conds = [eq(findings.projectId, req.projectId)];
      if (q.data.status) conds.push(eq(findings.status, q.data.status));
      if (q.data.priority) conds.push(eq(findings.priority, q.data.priority));
      const rows = await db
        .select()
        .from(findings)
        .where(and(...conds))
        .orderBy(asc(findings.priority), desc(findings.createdAt))
        .limit(q.data.limit);
      return { findings: await summarizeFindings(db, rows) };
    });

    app.get('/v1/findings/:id', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return bad(reply, p.error.issues);
      const f = await ownedFinding(db, req.projectId, p.data.id);
      if (!f) return notFound(reply);
      return findingDetail(f);
    });

    app.patch('/v1/findings/:id', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      const b = PatchFindingBody.safeParse(req.body);
      if (!p.success) return bad(reply, p.error.issues);
      if (!b.success) return bad(reply, b.error.issues);
      const f = await ownedFinding(db, req.projectId, p.data.id);
      if (!f) return notFound(reply);
      const next = b.data.status;
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(findings).set({ status: next }).where(eq(findings.id, f.id)).returning();
        if (next === 'dismissed' && f.status !== 'dismissed') {
          await tx
            .insert(noise)
            .values({ projectId: f.projectId, signature: f.signature, dismissCount: 1 })
            .onConflictDoUpdate({
              target: [noise.projectId, noise.signature],
              set: { dismissCount: sql`${noise.dismissCount} + 1` },
            });
        }
        return row!;
      });
      return findingDetail(updated);
    });

    app.get('/v1/scans/:id', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return bad(reply, p.error.issues);
      const owned = await ownedScan(db, req.projectId, p.data.id);
      if (!owned) return notFound(reply);
      const { scan, baseUrl } = owned;
      const [runs, finds, [usage]] = await Promise.all([
        db.select().from(agentRuns).where(eq(agentRuns.scanId, scan.id)).orderBy(asc(agentRuns.t0), asc(agentRuns.id)),
        db.select().from(findings).where(eq(findings.scanId, scan.id)).orderBy(asc(findings.priority), desc(findings.createdAt)),
        db
          .select({
            usd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`,
            tin: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)`,
            tout: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)`,
          })
          .from(llmUsage)
          .where(eq(llmUsage.scanId, scan.id)),
      ]);
      const out: ApiScanDetail = {
        id: scan.id,
        environmentId: scan.environmentId,
        baseUrl,
        status: scan.status,
        teamSize: scan.teamSize,
        allowedActions: scan.allowedActions,
        focus: scan.focus,
        viewports: scan.viewports,
        costUsd: scan.costUsd,
        startedAt: scan.startedAt?.toISOString() ?? null,
        finishedAt: scan.finishedAt?.toISOString() ?? null,
        runs: runs.map(runSummary),
        findings: await summarizeFindings(db, finds),
        cost: {
          scanUsd: scan.costUsd,
          runsUsd: runs.reduce((s, r) => s + r.costUsd, 0),
          llmUsd: Number(usage?.usd ?? 0),
          tokens: runs.reduce((s, r) => s + r.tokens, 0) || Number(usage?.tin ?? 0) + Number(usage?.tout ?? 0),
        },
      };
      return out;
    });

    app.get('/v1/scans/:id/findings', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      const q = ListFindingsQuery.safeParse(req.query);
      if (!p.success) return bad(reply, p.error.issues);
      if (!q.success) return bad(reply, q.error.issues);
      if (!(await ownedScan(db, req.projectId, p.data.id))) return notFound(reply);
      const conds = [eq(findings.scanId, p.data.id)];
      if (q.data.status) conds.push(eq(findings.status, q.data.status));
      if (q.data.priority) conds.push(eq(findings.priority, q.data.priority));
      const rows = await db
        .select()
        .from(findings)
        .where(and(...conds))
        .orderBy(asc(findings.priority), desc(findings.createdAt))
        .limit(q.data.limit);
      return { findings: await summarizeFindings(db, rows) };
    });

    app.get('/v1/runs/:id', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return bad(reply, p.error.issues);
      const run = await ownedRun(db, req.projectId, p.data.id);
      if (!run) return notFound(reply);
      const [rows, charterRows] = await Promise.all([
        db.select().from(steps).where(eq(steps.agentRunId, run.id)).orderBy(asc(steps.n)),
        run.charterId ? db.select().from(charters).where(eq(charters.id, run.charterId)).limit(1) : Promise.resolve([]),
      ]);
      const charter = charterRows[0];
      const out: ApiRun = {
        ...runSummary(run),
        charter: charter
          ? { id: charter.id, type: charter.type, area: charter.area, goal: charter.goal, viewport: charter.viewport }
          : null,
        videoUrl: sign(run.videoKey),
        traceUrl: sign(run.traceKey),
        timelineUrl: sign(run.timelineKey),
        steps: rows.map((s) => ({
          id: s.id,
          n: s.n,
          action: s.actionJson,
          locator: s.locatorJson ?? null,
          intent: s.intent,
          expectation: s.expectation,
          tMs: s.tMs,
          stateHash: s.stateHash,
          outcome: s.outcome,
          error: s.error,
          reasoningSummary: s.reasoningSummary,
          signals: s.signalsJson ?? [],
          screenshotUrl: sign(s.screenshotKey),
        })),
      };
      return out;
    });

    app.get('/v1/runs/:id/timeline', async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return bad(reply, p.error.issues);
      const run = await ownedRun(db, req.projectId, p.data.id);
      if (!run) return notFound(reply);
      if (!run.timelineKey) return notFound(reply);
      const tl = await loadTimeline(run);
      if (!tl) return reply.code(502).send({ error: 'timeline_unreadable' });
      const out: ApiTimeline = {
        ...tl,
        videoUrl: sign(tl.videoKey ?? run.videoKey),
        traceUrl: sign(tl.traceKey ?? run.traceKey),
        rrwebSegments: tl.rrwebSegments.map((s) => ({ ...s, signedUrl: signFilePath(s.key, secret) })),
        steps: tl.steps.map((s) => ({ ...s, screenshotUrl: sign(s.screenshotKey) })),
      };
      return out;
    });

    app.get('/v1/runs/:id/rrweb/:segment', async (req, reply) => {
      const p = segmentParam.safeParse(req.params);
      if (!p.success) return bad(reply, p.error.issues);
      const run = await ownedRun(db, req.projectId, p.data.id);
      if (!run) return notFound(reply);
      const tl = await loadTimeline(run);
      const key =
        tl?.rrwebSegments.find((s) => s.index === p.data.segment)?.key ?? (p.data.segment === 0 ? run.rrwebKey : null);
      if (!key) return notFound(reply);
      return reply.redirect(signFilePath(key, secret), 302);
    });
  };
}

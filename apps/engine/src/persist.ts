import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Browser } from 'playwright';
import {
  judgeCandidate,
  judgeExpectation,
  redact,
  runAgent,
  signatureFor,
  type AgentEvent,
  type Expectation,
} from '@gremlin/agent';
import type { Candidate, Charter, JudgeVerdict, OracleKind, Priority, Step } from '@gremlin/contract';
import {
  agentRuns,
  charters,
  environments,
  findingOccurrences,
  findings,
  llmUsage,
  noise,
  scans,
  steps as stepsTable,
  type Db,
} from '@gremlin/db';
import type { Llm, Usage } from '@gremlin/llm';
import type { Storage } from '@gremlin/storage';

import { loadSecrets } from './credentials.js';

/** Sign-in endpoints that stay writable in read_only mode when the run has a saved login. */
const LOGIN_PATHS = ['/login', '/signin', '/sign-in', '/api/login', '/api/signin', '/api/auth', '/auth', '/session', '/api/session', '/oauth'];

export type AgentJob = { scanId: string; runId: string; charter: Charter };

export type AgentJobDeps = {
  db: Db;
  storage: Storage;
  /** Must be created with `onUsage: createUsageSink(db)` for `llm_usage` rows to be written. */
  llm: Llm;
  browser: Browser;
  /** Values for `{{name}}` placeholders (scan-one: SCAN_USERNAME/SCAN_PASSWORD). Never persisted. */
  secrets?: Record<string, string>;
  budgets?: { steps?: number; ms?: number; tokens?: number };
  onEvent?: (e: AgentEvent) => void;
};

// --- llm_usage: one row per call, attributed to the job running in the current async context -------------------

type UsageScope = {
  scanId: string | null;
  agentRunId: string | null;
  pending: Promise<unknown>[];
  tokens: number;
  costUsd: number;
  calls: number;
};

const usageScope = new AsyncLocalStorage<UsageScope>();

/**
 * `onUsage` handler for `createLlm`. One shared Llm serves every concurrent job; AsyncLocalStorage tells the sink
 * which scan/run a call belongs to (calls outside a job are stored with null ids). Never throws.
 */
export function createUsageSink(db: Db): (u: Usage) => void {
  return (u) => {
    const scope = usageScope.getStore();
    const cost = u.costUsd ?? 0;
    const p = db
      .insert(llmUsage)
      .values({
        scanId: scope?.scanId ?? null,
        agentRunId: scope?.agentRunId ?? null,
        role: u.role,
        model: u.model,
        tokensIn: u.tokensIn,
        tokensOut: u.tokensOut,
        latencyMs: Math.round(u.latencyMs),
        costUsd: cost,
      })
      .catch(() => undefined); // telemetry must never fail a run
    if (scope) {
      scope.pending.push(p);
      scope.tokens += u.tokensIn + u.tokensOut;
      scope.costUsd += cost;
      scope.calls += 1;
    }
  };
}

// --- helpers ------------------------------------------------------------------------------------------------------

const CLIP = 2_000;
const clip = (s: string, n = CLIP) => (s.length <= n ? s : `${s.slice(0, n)}…`);
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const stepRow = (runId: string, s: Step) => ({
  agentRunId: runId, n: s.n, actionJson: s.action, locatorJson: s.locator,
  intent: s.intent, expectation: s.expectation ?? null, tMs: Math.round(s.tMs),
  stateHash: s.stateHash, screenshotKey: s.screenshotKey ?? null, signalsJson: s.signals,
  reasoningSummary: s.reasoningSummary ?? null, outcome: s.outcome, error: s.error ?? null,
});

/** Raw, JSON-escaped and URL-encoded forms of every secret (same coverage as the agent loop). */
function secretForms(secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  for (const v of Object.values(secrets)) {
    if (!v) continue;
    for (const f of new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])) if (f) out[`f${i++}`] = f;
  }
  return out;
}

type Verdict = { verdict: JudgeVerdict | null; reason?: string };

/** judge_unavailable (invalid output) and thrown LLM errors (outage) both mean "unjudged", never "not a bug". */
async function safeJudge(fn: () => Promise<JudgeVerdict>): Promise<Verdict> {
  try {
    const v = await fn();
    if (v.reasoning === 'judge_unavailable') return { verdict: null, reason: 'judge_unavailable' };
    return { verdict: v };
  } catch (e) {
    return { verdict: null, reason: clip(`judge_error: ${errMessage(e)}`, 500) };
  }
}

// --- processAgentJob ----------------------------------------------------------------------------------------------

/**
 * Runs one agent charter and persists everything: the agent_runs row (status, artifact keys, tokens, cost, error),
 * steps, findings (deduped by (project_id, signature) via the unique index + ON CONFLICT, so concurrent jobs are
 * safe), finding_occurrences, noise, and llm_usage (via the sink). On failure the run is marked 'error' with a
 * message and the error is rethrown.
 */
export async function processAgentJob(deps: AgentJobDeps, job: AgentJob): Promise<void> {
  const { db } = deps;
  let secrets = deps.secrets ?? {};
  let forms = secretForms(secrets);
  const scrub = (s: string) => redact(s, forms);
  const scrubJson = <T>(v: T): T => JSON.parse(scrub(JSON.stringify(v))) as T;
  const scope: UsageScope = { scanId: null, agentRunId: job.runId, pending: [], tokens: 0, costUsd: 0, calls: 0 };

  try {
    await usageScope.run(scope, async () => {
      const [ctx] = await db
        .select({ scan: scans, env: environments })
        .from(scans)
        .innerJoin(environments, eq(scans.environmentId, environments.id))
        .where(eq(scans.id, job.scanId))
        .limit(1);
      if (!ctx) throw new Error(`scan ${job.scanId} not found`);
      scope.scanId = ctx.scan.id;
      const projectId = ctx.env.projectId;
      if (!deps.secrets) {
        const key = process.env.GREMLIN_SECRET_KEY;
        if (key) {
          secrets = await loadSecrets(db, ctx.env.id, job.charter.persona, key);
          forms = secretForms(secrets);
        }
      }

      const [charterRow] = await db.select({ id: charters.id }).from(charters).where(eq(charters.id, job.charter.id)).limit(1);
      const startedAt = new Date();
      await db
        .insert(agentRuns)
        .values({
          id: job.runId,
          scanId: ctx.scan.id,
          charterId: charterRow?.id ?? null,
          kind: 'scan',
          status: 'running',
          t0: startedAt,
        })
        .onConflictDoUpdate({
          target: agentRuns.id,
          set: { status: 'running', scanId: ctx.scan.id, t0: startedAt, error: null },
        });

      const suppressedRows = await db
        .select({ signature: noise.signature })
        .from(noise)
        .where(and(eq(noise.projectId, projectId), sql`${noise.suppressed} > 0`));

      const stepIds = new Map<number, string>();
      const pendingSteps: Promise<void>[] = [];
      let stepError: unknown;
      const result = await runAgent({
        browser: deps.browser,
        baseUrl: ctx.env.baseUrl,
        charter: job.charter,
        llm: deps.llm,
        storage: deps.storage,
        runId: job.runId,
        keyPrefix: `runs/${job.runId}`,
        secrets,
        ...(Object.keys(secrets).length ? { authAllowlist: LOGIN_PATHS } : {}),
        allowedActions: ctx.scan.allowedActions === 'full' ? 'full' : 'read_only',
        ...(deps.budgets ? { budgets: deps.budgets } : {}),
        ...(suppressedRows.length ? { suppressed: new Set(suppressedRows.map((r) => r.signature)) } : {}),
        onEvent: (event) => {
          if (event.type === 'step') {
            const clean = scrubJson(event.step);
            const write = db.insert(stepsTable).values(stepRow(job.runId, clean))
              .returning({ id: stepsTable.id }).then(([row]) => { stepIds.set(clean.n, row!.id); })
              .catch((error: unknown) => { stepError = error; });
            pendingSteps.push(write);
          }
          deps.onEvent?.(event);
        },
      });
      await Promise.all(pendingSteps);
      if (stepError) throw stepError;

      // Steps: placeholder-form actions as the loop recorded them, scrubbed once more as a last line of defence.
      const runSteps = result.steps.map((s) => scrubJson(s));
      const missingSteps = runSteps.filter((s) => !stepIds.has(s.n));
      if (missingSteps.length) {
        const rows = await db
          .insert(stepsTable)
          .values(
            missingSteps.map((s) => ({
              agentRunId: job.runId,
              n: s.n,
              actionJson: s.action,
              locatorJson: s.locator,
              intent: s.intent,
              expectation: s.expectation ?? null,
              tMs: Math.round(s.tMs),
              stateHash: s.stateHash,
              screenshotKey: s.screenshotKey ?? null,
              signalsJson: s.signals,
              reasoningSummary: s.reasoningSummary ?? null,
              outcome: s.outcome,
              error: s.error ?? null,
            })),
          )
          .returning({ id: stepsTable.id, n: stepsTable.n });
        for (const r of rows) stepIds.set(r.n, r.id);
      }

      const p = new Persister(deps, projectId, ctx.scan.id, job.runId, runSteps, stepIds, scrubJson);
      for (const c of result.candidates) await p.candidate(scrubJson(c));
      for (const e of result.expectations) await p.expectation(scrubJson(e));

      await Promise.all(scope.pending);
      await db
        .update(agentRuns)
        .set({
          status: result.status,
          timelineKey: result.artifacts.timelineKey || null,
          traceKey: result.artifacts.traceKey || null,
          videoKey: result.artifacts.videoKey ?? null,
          rrwebKey: result.artifacts.rrwebKeys[0] ?? null,
          tokens: scope.calls ? scope.tokens : result.tokens,
          costUsd: scope.costUsd,
          error: result.error ? clip(scrub(result.error)) : null,
        })
        .where(eq(agentRuns.id, job.runId));
      if (scope.costUsd > 0) {
        await db
          .update(scans)
          .set({ costUsd: sql`${scans.costUsd} + ${scope.costUsd}` })
          .where(eq(scans.id, ctx.scan.id));
      }
    });
  } catch (e) {
    await Promise.allSettled(scope.pending);
    const message = clip(scrub(errMessage(e)));
    await db
      .insert(agentRuns)
      .values({ id: job.runId, kind: 'scan', status: 'error', error: message, tokens: scope.tokens, costUsd: scope.costUsd })
      .onConflictDoUpdate({ target: agentRuns.id, set: { status: 'error', error: message } })
      .catch(() => undefined);
    throw e;
  }
}

/** Candidate/expectation → finding logic for one run. */
class Persister {
  constructor(
    private readonly deps: AgentJobDeps,
    private readonly projectId: string,
    private readonly scanId: string,
    private readonly runId: string,
    private readonly steps: Step[],
    private readonly stepIds: Map<number, string>,
    private readonly scrubJson: <T>(v: T) => T,
  ) {}

  private stepIdFor(n: number): string | undefined {
    return this.stepIds.get(n) ?? this.stepIds.get(Math.max(0, ...this.stepIds.keys()));
  }

  private recentSteps(n: number): Step[] {
    return this.steps.filter((s) => s.n <= n).slice(-5);
  }

  private async shot(n: number): Promise<Buffer | undefined> {
    const key = this.steps.find((s) => s.n === n)?.screenshotKey;
    if (!key) return undefined;
    return this.deps.storage.get(key).catch(() => undefined);
  }

  private async existing(signature: string) {
    const [row] = await this.deps.db
      .select({ id: findings.id, unjudged: findings.unjudged })
      .from(findings)
      .where(and(eq(findings.projectId, this.projectId), eq(findings.signature, signature)))
      .limit(1);
    return row;
  }

  private async openTitles(): Promise<{ id: string; title: string }[]> {
    return this.deps.db
      .select({ id: findings.id, title: findings.title })
      .from(findings)
      .where(and(eq(findings.projectId, this.projectId), ne(findings.status, 'dismissed')))
      .orderBy(desc(findings.createdAt))
      .limit(30);
  }

  private async occurrence(findingId: string, stepN: number): Promise<void> {
    const stepId = this.stepIdFor(stepN);
    if (!stepId) return;
    await this.deps.db
      .insert(findingOccurrences)
      .values({ findingId, agentRunId: this.runId, stepId })
      .onConflictDoNothing();
  }

  private async feedNoise(signature: string): Promise<void> {
    await this.deps.db
      .insert(noise)
      .values({ projectId: this.projectId, signature, dismissCount: 1 })
      .onConflictDoUpdate({
        target: [noise.projectId, noise.signature],
        set: { dismissCount: sql`${noise.dismissCount} + 1` },
      });
  }

  private fields(v: Verdict, fallback: { priority: Priority; title: string; expected: string; actual: string }) {
    if (!v.verdict) {
      return { ...fallback, status: 'new', unjudged: true, verdictJson: { reason: v.reason ?? 'judge_unavailable' } };
    }
    const j = v.verdict;
    return {
      priority: j.priority,
      title: clip(j.title, 300),
      expected: clip(j.expected),
      actual: clip(j.actual),
      status: j.isBug ? 'new' : 'dismissed',
      unjudged: false,
      verdictJson: this.scrubJson(j),
    };
  }

  /** Insert, or (when another job won the race) fall back to the existing row. Race-safe via the unique index. */
  private async upsert(
    meta: { signature: string; oracle: OracleKind; url: string; stepN: number },
    f: ReturnType<Persister['fields']>,
  ): Promise<void> {
    const { db } = this.deps;
    const inserted = await db
      .insert(findings)
      .values({
        projectId: this.projectId,
        scanId: this.scanId,
        signature: meta.signature,
        oracle: meta.oracle,
        url: meta.url,
        ...f,
      })
      .onConflictDoNothing({ target: [findings.projectId, findings.signature] })
      .returning({ id: findings.id });
    if (inserted[0]) {
      if (f.status === 'dismissed') await this.feedNoise(meta.signature);
      await this.occurrence(inserted[0].id, meta.stepN);
      return;
    }
    const ex = await this.existing(meta.signature);
    if (!ex) throw new Error(`finding ${meta.signature} vanished`);
    await this.rejudged(ex, meta.signature, f);
    await this.occurrence(ex.id, meta.stepN);
  }

  /** An unjudged finding gets the first real verdict that comes along (exactly one job applies it). */
  private async rejudged(
    ex: { id: string; unjudged: boolean },
    signature: string,
    f: ReturnType<Persister['fields']>,
  ): Promise<void> {
    if (!ex.unjudged || f.unjudged) return;
    const updated = await this.deps.db
      .update(findings)
      .set(f)
      .where(and(eq(findings.id, ex.id), eq(findings.unjudged, true)))
      .returning({ id: findings.id });
    if (updated[0] && f.status === 'dismissed') await this.feedNoise(signature);
  }

  async candidate(c: Candidate): Promise<void> {
    const ex = await this.existing(c.signature);
    if (ex && !ex.unjudged) {
      await this.occurrence(ex.id, c.stepN);
      return;
    }
    const existing = await this.openTitles();
    const v = await safeJudge(async () =>
      judgeCandidate(this.deps.llm, {
        candidate: c,
        recentSteps: this.recentSteps(c.stepN),
        existing,
        ...(await this.shots(c.stepN)),
      }),
    );
    const evidence = c.evidence as { expected?: unknown; actual?: unknown };
    const f = this.fields(v, {
      priority: c.severity,
      title: clip(`${c.oracle}: ${c.message}`, 300),
      expected: typeof evidence.expected === 'string' ? clip(evidence.expected) : '',
      actual: typeof evidence.actual === 'string' ? clip(evidence.actual) : clip(c.message),
    });
    if (ex) {
      await this.rejudged(ex, c.signature, f);
      await this.occurrence(ex.id, c.stepN);
      return;
    }
    // A real bug the judge recognised as an existing finding: record it there.
    const dup = v.verdict?.isBug ? v.verdict.duplicateOf : null;
    if (dup) {
      await this.occurrence(dup, c.stepN);
      return;
    }
    await this.upsert({ signature: c.signature, oracle: c.oracle, url: c.url, stepN: c.stepN }, f);
  }

  private async shots(n: number): Promise<{ beforeShot?: Buffer; afterShot?: Buffer }> {
    const [before, after] = await Promise.all([this.shot(n - 1), this.shot(n)]);
    return { ...(before ? { beforeShot: before } : {}), ...(after ? { afterShot: after } : {}) };
  }

  async expectation(e: Expectation): Promise<void> {
    const v = await safeJudge(async () => {
      const r = await judgeExpectation(this.deps.llm, {
        statement: e.statement,
        before: e.before,
        after: e.after,
        recentSteps: this.recentSteps(e.stepN),
      });
      return r;
    });
    if (v.verdict && !v.verdict.isBug) return; // the expectation held
    const signature = signatureFor('expectation', e.after.url, e.statement);
    const f = this.fields(v, {
      priority: 'P2',
      title: clip(`Expectation not verified: ${e.statement}`, 300),
      expected: clip(e.statement),
      actual: '',
    });
    const ex = await this.existing(signature);
    if (ex) {
      await this.rejudged(ex, signature, f);
      await this.occurrence(ex.id, e.stepN);
      return;
    }
    await this.upsert({ signature, oracle: 'expectation', url: e.after.url, stepN: e.stepN }, f);
  }
}

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import type { Action, Charter, JudgeVerdict } from '@gremlin/contract';
import {
  agentRuns,
  createDb,
  environments,
  findingOccurrences,
  findings,
  llmUsage,
  migrate,
  noise,
  projects,
  scans,
  steps,
  type Db,
} from '@gremlin/db';
import { LlmError, type Llm, type Role, type ToolCallRequest, type Usage } from '@gremlin/llm';
import { FsStorage } from '@gremlin/storage';
import { createUsageSink, processAgentJob } from '../src/persist.js';
import { startWorkers } from '../src/worker.js';
import { connectionFromUrl } from '../src/queue.js';
import { startFixtureServer } from './fixtureServer.js';

const url = process.env.DATABASE_URL!;
const schema = `test_${randomBytes(6).toString('hex')}`;
let admin: ReturnType<typeof postgres>;
let db: Db;
let browser: Browser;
let storage: FsStorage;
let storageDir: string;
let server: { url: string; close(): Promise<void> };

async function launch(): Promise<Browser> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chromium.launch({ headless: true });
    } catch (e) {
      if (attempt >= 5 || !/spawn EPERM/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

beforeAll(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = createDb(url, { schema });
  await migrate(db, { schema });
  storageDir = await mkdtemp(join(tmpdir(), 'gremlin-worker-'));
  storage = new FsStorage(storageDir);
  server = await startFixtureServer();
  browser = await launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await db?.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  await rm(storageDir, { recursive: true, force: true });
});

// --- fake LLM ---------------------------------------------------------------------------------------------------

type JudgeFn = (prompt: string) => JudgeVerdict | Error;
type FakeLlm = Llm & { calls: number; judgeCalls: number };

function refOf(prompt: string, name: string): string {
  const m = new RegExp(`^(e\\d+) \\S+ "${name}"`, 'm').exec(prompt);
  if (!m) throw new Error(`no interactable "${name}" in prompt`);
  return m[1]!;
}

type NavItem = Action | ((prompt: string) => Action);
const clickAdd: NavItem = (p) => ({ type: 'click', ref: refOf(p, 'Add to cart'), intent: 'add the kayak' });
const finish: Action = { type: 'finish', reason: 'done', intent: 'stop' };
const NAV: NavItem[] = [
  clickAdd,
  { type: 'expect', statement: 'A free shipping banner appears', intent: 'check shipping' },
  clickAdd,
  finish,
];

const verdict = (over: Partial<JudgeVerdict>): JudgeVerdict => ({
  isBug: true,
  priority: 'P1',
  title: 'bug',
  expected: 'works',
  actual: 'broken',
  duplicateOf: null,
  reasoning: 'evidence',
  ...over,
});

/** Network 500 is a P1 bug; the console noise is not; the shipping expectation does not hold. */
const goodJudge: JudgeFn = (p) => {
  if (p.includes('stated an expectation')) {
    return p.includes('free shipping')
      ? verdict({ priority: 'P2', title: 'No free shipping banner' })
      : verdict({ isBug: false, priority: 'P3' });
  }
  if (p.includes('Oracle: network')) return verdict({ priority: 'P1', title: 'Cart API returns 500 on second add' });
  return verdict({ isBug: false, priority: 'P3', title: 'Analytics noise' });
};

function fakeLlm(judge: JudgeFn, onUsage: (u: Usage) => void, nav: NavItem[] = NAV): FakeLlm {
  let i = 0;
  const fake: FakeLlm = {
    calls: 0,
    judgeCalls: 0,
    async callTool<T>(role: Role, req: ToolCallRequest<T>) {
      const prompt = req.messages.map((m) => m.content).join('\n');
      let v: unknown;
      if (role === 'navigator') {
        const item = i < nav.length ? nav[i++]! : finish;
        v = typeof item === 'function' ? item(prompt) : item;
      } else {
        fake.judgeCalls += 1;
        v = judge(prompt);
      }
      if (v instanceof Error) throw v;
      fake.calls += 1;
      const usage: Usage = { role, model: 'fake', tokensIn: 100, tokensOut: 10, latencyMs: 5, costUsd: 0.001 };
      onUsage(usage);
      return { value: req.tool.schema.parse(v), usage };
    },
  };
  return fake;
}

// --- fixtures -----------------------------------------------------------------------------------------------------

async function seed(name: string, allowedActions: 'read_only' | 'full' = 'full') {
  const [p] = await db.insert(projects).values({ name }).returning();
  const [env] = await db
    .insert(environments)
    .values({ projectId: p!.id, baseUrl: server.url, allowedActions })
    .returning();
  const [scan] = await db.insert(scans).values({ environmentId: env!.id, allowedActions, status: 'scanning' }).returning();
  return { projectId: p!.id, scanId: scan!.id };
}

async function newRun(scanId: string | null): Promise<string> {
  const [r] = await db.insert(agentRuns).values({ scanId, kind: 'scan' }).returning();
  return r!.id;
}

const charter: Charter = {
  id: 'c1',
  area: 'shop',
  goal: 'Add a kayak to the cart twice',
  type: 'happy_path',
  startPath: '/cart.html',
  risk: 1,
  viewport: 'desktop',
};

const findingsOf = (projectId: string) => db.select().from(findings).where(eq(findings.projectId, projectId));
const usageOf = (runId: string) => db.select().from(llmUsage).where(eq(llmUsage.agentRunId, runId));
const occurrencesOf = (findingId: string) =>
  db.select().from(findingOccurrences).where(eq(findingOccurrences.findingId, findingId));

// --- tests --------------------------------------------------------------------------------------------------------

describe('processAgentJob', () => {
  it('persists run, steps and findings; dedupes reruns into occurrences; dismisses non-bugs', async () => {
    const { projectId, scanId } = await seed('dedupe');
    const sink = createUsageSink(db);

    const run1 = await newRun(scanId);
    const llm1 = fakeLlm(goodJudge, sink);
    await processAgentJob(
      { db, storage, llm: llm1, browser, secrets: { password: 'S3cret!x' } },
      { scanId, runId: run1, charter },
    );

    const [r1] = await db.select().from(agentRuns).where(eq(agentRuns.id, run1));
    expect(r1!.status).toBe('finished');
    expect(r1!.error).toBeNull();
    expect(r1!.timelineKey).toBeTruthy();
    expect(r1!.traceKey).toBeTruthy();
    expect(r1!.tokens).toBe(llm1.calls * 110);
    expect(r1!.costUsd).toBeCloseTo(llm1.calls * 0.001, 6);
    expect(await storage.exists(r1!.timelineKey!)).toBe(true);

    const st = await db.select().from(steps).where(eq(steps.agentRunId, run1));
    expect(st.map((s) => s.n).sort()).toEqual([1, 2, 3, 4]);
    expect(st.every((s) => s.outcome !== null)).toBe(true);
    expect(JSON.stringify(st)).not.toContain('S3cret!x');

    let fs1 = await findingsOf(projectId);
    const network = fs1.find((f) => f.oracle === 'network');
    expect(network).toMatchObject({ priority: 'P1', status: 'new', unjudged: false });
    const consoleF = fs1.find((f) => f.oracle === 'console');
    expect(consoleF).toMatchObject({ status: 'dismissed', unjudged: false });
    const expectation = fs1.find((f) => f.oracle === 'expectation');
    expect(expectation).toMatchObject({ status: 'new', priority: 'P2', title: 'No free shipping banner' });
    expect(fs1).toHaveLength(3);
    expect(await occurrencesOf(network!.id)).toHaveLength(1);

    // Dismissed candidates feed the noise list.
    const nz = await db.select().from(noise).where(eq(noise.projectId, projectId));
    expect(nz).toEqual([expect.objectContaining({ signature: consoleF!.signature, dismissCount: 1 })]);

    // One llm_usage row per (successful) call, scoped to the run and scan.
    const u1 = await usageOf(run1);
    expect(u1).toHaveLength(llm1.calls);
    expect(u1.every((u) => u.scanId === scanId)).toBe(true);
    expect(u1.filter((u) => u.role === 'navigator')).toHaveLength(4);
    expect(u1.filter((u) => u.role === 'judge')).toHaveLength(3);

    // Same job again: occurrences, no new findings; known signatures are not re-judged (only the expectation is).
    const run2 = await newRun(scanId);
    const llm2 = fakeLlm(goodJudge, sink);
    await processAgentJob({ db, storage, llm: llm2, browser }, { scanId, runId: run2, charter });
    fs1 = await findingsOf(projectId);
    expect(fs1).toHaveLength(3);
    expect(await occurrencesOf(network!.id)).toHaveLength(2);
    expect(await occurrencesOf(expectation!.id)).toHaveLength(2);
    expect(llm2.judgeCalls).toBe(1);
    expect(await usageOf(run2)).toHaveLength(llm2.calls);
    const nz2 = await db.select().from(noise).where(eq(noise.projectId, projectId));
    expect(nz2[0]!.dismissCount).toBe(1);

    const [sc] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(sc!.costUsd).toBeCloseTo((llm1.calls + llm2.calls) * 0.001, 6);
  }, 180_000);

  it('stores judge_unavailable candidates as new + unjudged (not dismissed, no noise), and re-judges them later', async () => {
    const { projectId, scanId } = await seed('unjudged');
    const sink = createUsageSink(db);
    const down: JudgeFn = () => new LlmError('invalid_output', 'tool arguments failed validation');

    const run1 = await newRun(scanId);
    await processAgentJob({ db, storage, llm: fakeLlm(down, sink), browser }, { scanId, runId: run1, charter });
    let fs = await findingsOf(projectId);
    // network + console + expectation, all unjudged and none dismissed.
    expect(fs).toHaveLength(3);
    expect(fs.every((f) => f.status === 'new' && f.unjudged)).toBe(true);
    expect(fs.find((f) => f.oracle === 'network')!.priority).toBe('P1');
    expect(await db.select().from(noise).where(eq(noise.projectId, projectId))).toHaveLength(0);

    // Judge is back: the unjudged findings are re-judged on their next occurrence.
    const run2 = await newRun(scanId);
    await processAgentJob({ db, storage, llm: fakeLlm(goodJudge, sink), browser }, { scanId, runId: run2, charter });
    fs = await findingsOf(projectId);
    expect(fs.find((f) => f.oracle === 'network')).toMatchObject({ status: 'new', unjudged: false, title: 'Cart API returns 500 on second add' });
    expect(fs.find((f) => f.oracle === 'console')).toMatchObject({ status: 'dismissed', unjudged: false });
    expect(await db.select().from(noise).where(eq(noise.projectId, projectId))).toHaveLength(1);
  }, 180_000);

  it('dedupes concurrent runs of the same project into one finding (race-safe)', async () => {
    const { projectId, scanId } = await seed('race');
    const sink = createUsageSink(db);
    const runs = [await newRun(scanId), await newRun(scanId)];
    await Promise.all(
      runs.map((runId) =>
        processAgentJob({ db, storage, llm: fakeLlm(goodJudge, sink, [clickAdd, clickAdd, finish]), browser }, { scanId, runId, charter }),
      ),
    );
    const fs = await findingsOf(projectId);
    const net = fs.filter((f) => f.oracle === 'network');
    expect(net).toHaveLength(1);
    expect(await occurrencesOf(net[0]!.id)).toHaveLength(2);
  }, 180_000);

  it('marks the run as error with a message when the job cannot run', async () => {
    const runId = await newRun(null);
    const llm = fakeLlm(goodJudge, createUsageSink(db));
    await expect(
      processAgentJob({ db, storage, llm, browser }, { scanId: 'no-such-scan', runId, charter }),
    ).rejects.toThrow(/scan/);
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(r!.status).toBe('error');
    expect(r!.error).toMatch(/scan/);
  });
});

describe('startWorkers', () => {
  it('persists steps before the next navigator call finishes, for live SSE', async () => {
    const { scanId } = await seed('live-progress');
    const runId = await newRun(scanId);
    const inner = fakeLlm(goodJudge, createUsageSink(db), [clickAdd, finish]);
    let calls = 0;
    let liveSteps = 0;
    const llm: Llm = {
      async callTool(role, req) {
        if (role === 'navigator' && ++calls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const recorded = await db.select().from(steps).where(eq(steps.agentRunId, runId));
          liveSteps = recorded.length;
        }
        return inner.callTool(role, req);
      },
    };
    await processAgentJob({ db, storage, llm, browser }, { scanId, runId, charter });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(liveSteps).toBeGreaterThan(0);
    const recorded = await db.select().from(steps).where(eq(steps.agentRunId, runId));
    expect(new Set(recorded.map((s) => s.n)).size).toBe(recorded.length);
  }, 120_000);

  it('consumes the agent queue, survives a failing job, and shuts down cleanly', async () => {
    const prefix = `gremlin-test-${randomBytes(6).toString('hex')}`;
    const redisUrl = process.env.REDIS_URL!;
    const { projectId, scanId } = await seed('worker');
    const sink = createUsageSink(db);
    const llm = fakeLlm(goodJudge, sink, [clickAdd, clickAdd, finish]);
    const workers = await startWorkers({ db, storage, llm, redisUrl, prefix, concurrency: 2 });
    const queue = new Queue('agent', { connection: connectionFromUrl(redisUrl), prefix });
    try {
      const bad = await newRun(null);
      const good = await newRun(scanId);
      await queue.add('run', { scanId: 'missing', runId: bad, charter });
      await queue.add('run', { scanId, runId: good, charter });

      const deadline = Date.now() + 120_000;
      for (;;) {
        const rows = await db.select().from(agentRuns).where(and(eq(agentRuns.scanId, scanId), eq(agentRuns.id, good)));
        const [b] = await db.select().from(agentRuns).where(eq(agentRuns.id, bad));
        if (rows[0]?.status === 'finished' && b?.status === 'error') break;
        if (Date.now() > deadline) throw new Error(`timeout: good=${rows[0]?.status} bad=${b?.status}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      const [b] = await db.select().from(agentRuns).where(eq(agentRuns.id, bad));
      expect(b!.error).toMatch(/scan/);
      expect((await findingsOf(projectId)).some((f) => f.oracle === 'network')).toBe(true);
      expect(workers.browser().isConnected()).toBe(true);
    } finally {
      const b = workers.browser();
      await workers.close();
      expect(b.isConnected()).toBe(false);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 180_000);
});

import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  agentRuns,
  createDb,
  environments,
  findingOccurrences,
  findings,
  migrate,
  playbooks,
  projects,
  scans,
  steps,
  type Db,
} from '@gremlin/db';
import { createApiKey, createQueues, mcpRoutes, type Queues } from '../src/index.js';

const url = process.env.DATABASE_URL!;
const schema = `test_${randomBytes(6).toString('hex')}`;
const prefix = `gremlin-test-${randomBytes(6).toString('hex')}`;
const WEB = 'https://web.example.test';
let admin: ReturnType<typeof postgres>;
let db: Db;
let queues: Queues;
let app: FastifyInstance;
let base: string;
let keyA: string;
let keyB: string;
let projectA: string;
let projectB: string;
const ids = {} as { scan: string; run: string; finding: string; otherFinding: string };
const clients: Client[] = [];

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  clients.push(client);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: r.isError === true, data: JSON.parse(r.content[0]!.text) as Record<string, any> };
}

beforeAll(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = createDb(url, { schema });
  await migrate(db, { schema });
  queues = createQueues(process.env.REDIS_URL!, { prefix });
  app = Fastify();
  app.register(mcpRoutes({ db, queues, webUrl: WEB }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const [pa] = await db.insert(projects).values({ name: 'a' }).returning();
  const [pb] = await db.insert(projects).values({ name: 'b' }).returning();
  projectA = pa!.id;
  projectB = pb!.id;
  keyA = await createApiKey(db, projectA);
  keyB = await createApiKey(db, projectB);

  const [env] = await db.insert(environments).values({ projectId: projectA, baseUrl: 'https://shop.test' }).returning();
  const [scan] = await db.insert(scans).values({ environmentId: env!.id, status: 'done', costUsd: 0.1234 }).returning();
  const [run] = await db.insert(agentRuns).values({ scanId: scan!.id, kind: 'scan', status: 'done' }).returning();
  const [, s2] = await db
    .insert(steps)
    .values([
      { agentRunId: run!.id, n: 1, tMs: 10, actionJson: { type: 'goto', path: '/cart', intent: 'open cart' } },
      {
        agentRunId: run!.id,
        n: 2,
        tMs: 900,
        actionJson: { type: 'click', ref: 'e3', intent: 'click Checkout' },
        locatorJson: { role: { role: 'button', name: 'Checkout' }, css: 'button.co' },
        signalsJson: [{ kind: 'pageerror', message: 'TypeError: x is undefined, token=supersecretvalue123', tMs: 950 }],
      },
    ])
    .returning();
  const [f] = await db
    .insert(findings)
    .values({
      projectId: projectA,
      scanId: scan!.id,
      signature: 'sig-1',
      priority: 'P1',
      title: 'Checkout crashes',
      expected: 'Order page loads',
      actual: 'Uncaught TypeError, key grm_abcdefghijklmnopqrstuvwxyz123456',
      status: 'confirmed',
      oracle: 'crash',
      url: 'https://shop.test/cart',
    })
    .returning();
  await db.insert(findingOccurrences).values({ findingId: f!.id, agentRunId: run!.id, stepId: s2!.id });
  await db.insert(findings).values({
    projectId: projectA,
    scanId: scan!.id,
    signature: 'sig-2',
    priority: 'P3',
    title: 'Minor',
    expected: 'e',
    actual: 'a',
    status: 'new',
  });
  const [other] = await db
    .insert(findings)
    .values({ projectId: projectB, signature: 'sig-b', priority: 'P2', title: 'B only', expected: 'e', actual: 'a' })
    .returning();
  await db.insert(playbooks).values({ projectId: projectA, version: 1, bodyMd: '# Playbook v1' });
  await db.insert(playbooks).values({ projectId: projectA, version: 2, bodyMd: '# Playbook v2' });
  Object.assign(ids, { scan: scan!.id, run: run!.id, finding: f!.id, otherFinding: other!.id });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await app?.close();
  if (queues) {
    for (const q of Object.values(queues)) {
      await q.obliterate({ force: true });
      await q.close();
    }
  }
  await db?.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

describe('mcp auth and transport', () => {
  it('rejects missing and bad keys with 401', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    }
  });

  it('GET /mcp is 405 (stateless)', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${keyA}` } });
    expect(res.status).toBe(405);
  });

  it('lists exactly the 10 spec tools', async () => {
    const c = await connect(keyA);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'get_playbook',
        'start_scan',
        'get_scan',
        'wait_scan',
        'list_findings',
        'get_finding',
        'get_fix_prompt',
        'run_relevant_scenarios',
        'run_scenarios',
        'verify_fix',
        'report_fix_outcome',
      ].sort(),
    );
  });
});

describe('mcp tools', () => {
  it('get_playbook returns the latest playbook and rejects foreign projects', async () => {
    const c = await connect(keyA);
    const ok = await call(c, 'get_playbook', { projectId: projectA });
    expect(ok.data.playbook).toEqual({ version: 2, bodyMd: '# Playbook v2' });
    expect(ok.data.memory.findingCounts).toMatchObject({ confirmed: 1, new: 1 });
    expect(ok.data.environments[0].baseUrl).toBe('https://shop.test');
    const bad = await call(c, 'get_playbook', { projectId: projectB });
    expect(bad.isError).toBe(true);
  });

  it('start_scan creates an environment and queued scan, enqueues discovery', async () => {
    const c = await connect(keyA);
    const r = await call(c, 'start_scan', { url: 'https://new.example.test/some/path', teamSize: 3, focus: 'checkout' });
    expect(r.isError).toBe(false);
    const [scan] = await db.select().from(scans).where(eq(scans.id, r.data.scanId));
    expect(scan).toMatchObject({ status: 'queued', teamSize: 3, focus: 'checkout', allowedActions: 'read_only' });
    const jobs = await queues.discovery.getJobs(['waiting']);
    expect(jobs.some((j) => j.data.scanId === r.data.scanId)).toBe(true);
    const none = await call(c, 'start_scan', {});
    expect(none.isError).toBe(true);
    const bad = await c.callTool({ name: 'start_scan', arguments: { url: 'ftp://x.test' } }).catch((e) => e);
    expect(bad instanceof Error || (bad as { isError?: boolean }).isError).toBeTruthy();
  });

  it('get_scan and wait_scan report status, progress and cost', async () => {
    const c = await connect(keyA);
    const g = await call(c, 'get_scan', { scanId: ids.scan });
    expect(g.data).toMatchObject({ status: 'done', costUsd: 0.1234, done: true, url: 'https://shop.test' });
    expect(g.data.progress.runs).toEqual({ done: 1 });
    expect(g.data.progress.findings).toEqual({ confirmed: 1, new: 1 });
    const w = await call(c, 'wait_scan', { scanId: ids.scan, timeoutS: 2 });
    expect(w.data).toMatchObject({ done: true, timedOut: false });
    const [env] = await db.select().from(environments).where(eq(environments.projectId, projectA)).limit(1);
    const [q] = await db.insert(scans).values({ environmentId: env!.id, status: 'queued' }).returning();
    const t0 = Date.now();
    const w2 = await call(c, 'wait_scan', { scanId: q!.id, timeoutS: 1 });
    expect(w2.data).toMatchObject({ done: false, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await call(c, 'get_scan', { scanId: 'missing' })).isError).toBe(true);
  });

  it('list_findings filters, limits, flags truncation and includes replay URLs', async () => {
    const c = await connect(keyA);
    const all = await call(c, 'list_findings', { scanId: ids.scan });
    expect(all.data.findings).toHaveLength(2);
    expect(all.data.truncated).toBe(false);
    const first = all.data.findings[0];
    expect(first.id).toBe(ids.finding);
    expect(first.replayUrl).toBe(`${WEB}/runs/${ids.run}?step=2&finding=${ids.finding}`);
    expect(all.data.findings[1].replayUrl).toBeNull();
    const lim = await call(c, 'list_findings', { scanId: ids.scan, limit: 1 });
    expect(lim.data.findings).toHaveLength(1);
    expect(lim.data.truncated).toBe(true);
    const st = await call(c, 'list_findings', { scanId: ids.scan, status: 'new' });
    expect(st.data.findings.map((f: { title: string }) => f.title)).toEqual(['Minor']);
  });

  it('get_finding returns details, redacts secrets and enforces tenancy', async () => {
    const c = await connect(keyA);
    const r = await call(c, 'get_finding', { id: ids.finding });
    expect(r.data).toMatchObject({ title: 'Checkout crashes', priority: 'P1', expected: 'Order page loads' });
    expect(r.data.steps.map((s: { n: number }) => s.n)).toEqual([1, 2]);
    expect(r.data.replayUrl).toContain(`step=2&finding=${ids.finding}`);
    const text = JSON.stringify(r.data);
    expect(text).not.toContain('grm_abcdef');
    expect(text).not.toContain('supersecretvalue123');
    expect((await call(c, 'get_finding', { id: ids.otherFinding })).isError).toBe(true);
  });

  it('get_fix_prompt includes replay link, steps, signals and a Playwright test', async () => {
    const c = await connect(keyA);
    const r = await call(c, 'get_fix_prompt', { id: ids.finding });
    const p = r.data.prompt as string;
    expect(p).toContain('Checkout crashes');
    expect(p).toContain(`${WEB}/runs/${ids.run}?step=2&finding=${ids.finding}`);
    expect(p).toContain('without weakening');
    expect(p).toContain('verify_fix');
    expect(p).not.toContain('supersecretvalue123');
    expect(r.data.playwrightTest).toContain('page.getByRole("button", { name: "Checkout" }).click()');
    expect(r.data.playwrightTest).toContain('page.goto(');
  });

  it('run_scenarios validates yaml, saves, queues runs; run_relevant_scenarios matches triggers', async () => {
    const c = await connect(keyA);
    const bad = await call(c, 'run_scenarios', { yaml: ['name: x'], url: 'https://shop.test' });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toContain('invalid scenario yaml');
    const yaml = [
      'name: checkout happy path',
      'persona: shopper',
      'allowed_actions: read_only',
      'steps: [open the cart, click Checkout]',
      'outcomes: [order page loads]',
      'triggers: ["src/checkout/*", "/cart"]',
    ].join('\n');
    const r = await call(c, 'run_scenarios', { yaml: [yaml], url: 'https://shop.test' });
    expect(r.isError).toBe(false);
    expect(r.data.runs).toHaveLength(1);
    const sid = r.data.runs[0].scenarioId as string;
    const again = await call(c, 'run_scenarios', { ids: [sid], url: 'https://shop.test' });
    expect(again.data.runs).toHaveLength(1);
    expect((await call(c, 'run_scenarios', { ids: ['nope'], url: 'https://shop.test' })).isError).toBe(true);
    expect((await call(c, 'run_scenarios', { url: 'https://shop.test' })).isError).toBe(true);

    const rel = await call(c, 'run_relevant_scenarios', {
      projectId: projectA,
      changedFiles: ['src/checkout/pay.ts'],
      changedRoutes: [],
      url: 'https://shop.test',
    });
    expect(rel.data.matched).toBe(1);
    expect(rel.data.queued).toHaveLength(1);
    const none = await call(c, 'run_relevant_scenarios', {
      projectId: projectA,
      changedFiles: ['README.md'],
      changedRoutes: ['/about'],
      url: 'https://shop.test',
    });
    expect(none.data.matched).toBe(0);
    const jobs = await queues.confirm.getJobs(['waiting']);
    expect(jobs.filter((j) => j.name === 'scenario').length).toBeGreaterThanOrEqual(3);

    // tenancy: project B cannot run project A's scenario
    const cb = await connect(keyB);
    expect((await call(cb, 'run_scenarios', { ids: [sid], url: 'https://x.test' })).isError).toBe(true);
  });

  it('verify_fix queues a verify run and report_fix_outcome closes the loop', async () => {
    const c = await connect(keyA);
    const v = await call(c, 'verify_fix', { findingId: ids.finding, url: 'https://preview.shop.test' });
    expect(v.data.status).toBe('queued');
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, v.data.runId));
    expect(run).toMatchObject({ kind: 'verify', status: 'queued' });
    const jobs = await queues.confirm.getJobs(['waiting']);
    expect(
      jobs.some((j) => j.name === 'verify' && j.data.findingId === ids.finding && j.data.url === 'https://preview.shop.test'),
    ).toBe(true);
    expect((await call(c, 'verify_fix', { findingId: ids.otherFinding, url: 'https://x.test' })).isError).toBe(true);

    const o = await call(c, 'report_fix_outcome', { findingId: ids.finding, promptVariant: 'v1', outcome: 'fixed' });
    expect(o.data).toEqual({ findingId: ids.finding, fixStatus: 'fixed' });
    const [f] = await db.select().from(findings).where(eq(findings.id, ids.finding));
    expect(f).toMatchObject({ status: 'fixed', fixStatus: 'fixed', promptVariant: 'v1' });
    expect(
      (await call(c, 'report_fix_outcome', { findingId: ids.otherFinding, promptVariant: 'v1', outcome: 'fixed' })).isError,
    ).toBe(true);
  });
});

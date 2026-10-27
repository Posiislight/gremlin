import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  agentRuns,
  charters,
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
import { FsStorage } from '@gremlin/storage';
import {
  ApiFindingDetail,
  ApiRun,
  ApiScanDetail,
  ApiTimeline,
  ListFindingsResponse,
  ListProjectsResponse,
  ScanEvent,
} from '@gremlin/contract';
import { buildServer, createApiKey, createQueues, type Queues } from '../src/index.js';

const url = process.env.DATABASE_URL!;
const schema = `test_${randomBytes(6).toString('hex')}`;
const prefix = `gremlin-test-${randomBytes(6).toString('hex')}`;
let admin: ReturnType<typeof postgres>;
let db: Db;
let queues: Queues;
let app: FastifyInstance;
let dir: string;
let storage: FsStorage;
let keyA: string;
let keyB: string;
let projectA: string;
let scanId: string;
let runId: string;
let f1: string;
let f2: string;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const get = (path: string, key = keyA) => app.inject({ method: 'GET', url: path, headers: auth(key) });

beforeAll(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = createDb(url, { schema });
  await migrate(db, { schema });
  queues = createQueues(process.env.REDIS_URL!, { prefix });
  dir = await mkdtemp(join(tmpdir(), 'gremlin-api-'));
  storage = new FsStorage(dir);
  app = buildServer({ db, storage, queues, webOrigin: 'http://dash.test', eventPollMs: 50 });
  await app.ready();

  const [pa] = await db.insert(projects).values({ name: 'a' }).returning();
  const [pb] = await db.insert(projects).values({ name: 'b' }).returning();
  projectA = pa!.id;
  keyA = await createApiKey(db, pa!.id);
  keyB = await createApiKey(db, pb!.id);

  const [env] = await db.insert(environments).values({ projectId: pa!.id, baseUrl: 'http://shop.test' }).returning();
  const [scan] = await db
    .insert(scans)
    .values({ environmentId: env!.id, status: 'running', teamSize: 2, costUsd: 0.5, startedAt: new Date() })
    .returning();
  const [charter] = await db.insert(charters).values({ scanId: scan!.id, type: 'explore', goal: 'poke around' }).returning();

  const timeline = {
    runId: 'run1',
    t0: 1000,
    durationMs: 5000,
    videoKey: 'runs/r/video.webm',
    rrwebSegments: [{ index: 0, startMs: 0, endMs: 5000, url: 'http://shop.test/', key: 'runs/r/rrweb-0.json' }],
    steps: [
      {
        n: 1,
        action: { type: 'goto', path: '/', intent: 'open home' },
        locator: null,
        intent: 'open home',
        tMs: 10,
        stateHash: 'h1',
        screenshotKey: 'runs/r/s1.png',
        signals: [],
        outcome: 'ok',
      },
    ],
    signals: [],
    findings: [],
  };
  await storage.put('runs/r/timeline.json', Buffer.from(JSON.stringify(timeline)), 'application/json');
  await storage.put('runs/r/rrweb-0.json', Buffer.from('[]'), 'application/json');

  const [run] = await db
    .insert(agentRuns)
    .values({
      scanId: scan!.id,
      charterId: charter!.id,
      kind: 'scan',
      status: 'running',
      t0: new Date(),
      videoKey: 'runs/r/video.webm',
      rrwebKey: 'runs/r/rrweb-0.json',
      timelineKey: 'runs/r/timeline.json',
      tokens: 1200,
      costUsd: 0.2,
    })
    .returning();
  const [s1] = await db
    .insert(steps)
    .values({
      agentRunId: run!.id,
      n: 1,
      actionJson: { type: 'goto', path: '/', intent: 'open home' },
      intent: 'open home',
      tMs: 10,
      stateHash: 'h1',
      screenshotKey: 'runs/r/s1.png',
      signalsJson: [],
      outcome: 'ok',
    })
    .returning();
  const mk = (sig: string, priority: string, status: string, title: string) =>
    db
      .insert(findings)
      .values({
        projectId: pa!.id,
        scanId: scan!.id,
        signature: sig,
        priority,
        title,
        expected: 'works',
        actual: 'broken',
        status,
        oracle: 'console',
        url: 'http://shop.test/cart',
        verdictJson: { isBug: true, priority, title, expected: 'works', actual: 'broken', duplicateOf: null, reasoning: 'r' },
      })
      .returning();
  const [a] = await mk('sig1', 'P1', 'new', 'Cart crashes');
  const [b] = await mk('sig2', 'P3', 'confirmed', 'Typo');
  await db.insert(findingOccurrences).values({ findingId: a!.id, agentRunId: run!.id, stepId: s1!.id });
  await db.insert(llmUsage).values({ scanId: scan!.id, role: 'navigator', model: 'm', tokensIn: 10, tokensOut: 5, costUsd: 0.3 });

  scanId = scan!.id;
  runId = run!.id;
  f1 = a!.id;
  f2 = b!.id;
});

afterAll(async () => {
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
  await rm(dir, { recursive: true, force: true });
});

describe('auth and CORS', () => {
  it('requires a key on every route', async () => {
    for (const p of ['/v1/projects', `/v1/findings/${f1}`, `/v1/runs/${runId}`, `/v1/scans/${scanId}/events`]) {
      expect((await app.inject({ method: 'GET', url: p })).statusCode).toBe(401);
    }
  });

  it('answers preflight without auth and sets allow-origin for the configured origin', async () => {
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v1/findings/x',
      headers: { origin: 'http://dash.test', 'access-control-request-method': 'PATCH' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://dash.test');
    expect(pre.headers['access-control-allow-methods']).toContain('PATCH');
    const res = await app.inject({ method: 'GET', url: '/v1/projects', headers: { ...auth(keyA), origin: 'http://dash.test' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://dash.test');
    const other = await app.inject({ method: 'GET', url: '/v1/projects', headers: { ...auth(keyA), origin: 'http://evil.test' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('projects and findings', () => {
  it('shows a deduplicated finding on the later scan that reproduced it', async () => {
    const [original] = await db.select().from(scans).where(eq(scans.id, scanId));
    const [repeat] = await db.insert(scans).values({ environmentId: original!.environmentId, status: 'done' }).returning();
    const [run] = await db.insert(agentRuns).values({ scanId: repeat!.id, kind: 'scan', status: 'finished' }).returning();
    const [step] = await db.insert(steps).values({ agentRunId: run!.id, n: 1, tMs: 1, actionJson: { type: 'finish', reason: 'done', intent: 'finish' } }).returning();
    await db.insert(findingOccurrences).values({ findingId: f1, agentRunId: run!.id, stepId: step!.id });
    const detail = ApiScanDetail.parse((await get(`/v1/scans/${repeat!.id}`)).json());
    expect(detail.findings.map((f) => f.id)).toContain(f1);
    expect((await get(`/v1/scans/${repeat!.id}/findings`)).json().findings.map((f: { id: string }) => f.id)).toContain(f1);
    const index = (await get(`/v1/projects/${projectA}/scans`)).json().scans;
    expect(index.find((s: { id: string }) => s.id === repeat!.id).findingCount).toBe(1);
    await db.delete(findingOccurrences).where(eq(findingOccurrences.stepId, step!.id));
    await db.delete(steps).where(eq(steps.id, step!.id));
    await db.delete(agentRuns).where(eq(agentRuns.id, run!.id));
    await db.delete(scans).where(eq(scans.id, repeat!.id));
  });

  it('lists project scans with dashboard counts and isolates other projects', async () => {
    const res = await get(`/v1/projects/${projectA}/scans`);
    expect(res.statusCode).toBe(200);
    const row = res.json().scans.find((s: { id: string }) => s.id === scanId);
    expect(row).toMatchObject({ id: scanId, projectId: projectA, baseUrl: 'http://shop.test', findingCount: 2, p0: 0, p1: 1 });
    expect((await get(`/v1/projects/${projectA}/scans`, keyB)).statusCode).toBe(404);
  });

  it('lists only the key project', async () => {
    const body = ListProjectsResponse.parse((await get('/v1/projects')).json());
    expect(body.projects.map((p) => p.id)).toEqual([projectA]);
  });

  it('lists findings with filters', async () => {
    const all = ListFindingsResponse.parse((await get(`/v1/projects/${projectA}/findings`)).json());
    expect(all.findings.map((f) => f.title)).toEqual(['Cart crashes', 'Typo']);
    expect(all.findings[0]!.occurrenceCount).toBe(1);
    const st = ListFindingsResponse.parse((await get(`/v1/projects/${projectA}/findings?status=confirmed`)).json());
    expect(st.findings.map((f) => f.id)).toEqual([f2]);
    const pr = ListFindingsResponse.parse((await get(`/v1/projects/${projectA}/findings?priority=P1`)).json());
    expect(pr.findings.map((f) => f.id)).toEqual([f1]);
    expect((await get(`/v1/projects/${projectA}/findings?status=bogus`)).statusCode).toBe(400);
    expect((await get(`/v1/projects/${projectA}/findings`, keyB)).statusCode).toBe(404);
  });

  it('returns finding detail with occurrences, verdict and signed screenshots', async () => {
    const res = await get(`/v1/findings/${f1}`);
    expect(res.statusCode).toBe(200);
    const f = ApiFindingDetail.parse(res.json());
    expect(f.verdict).toMatchObject({ isBug: true });
    expect(f.occurrences).toHaveLength(1);
    expect(f.occurrences[0]!.screenshotUrl).toMatch(/^\/v1\/files\/runs\/r\/s1\.png\?expires=\d+&sig=[0-9a-f]+$/);
    expect(f.screenshotUrls).toEqual([f.occurrences[0]!.screenshotUrl]);
  });

  it('provides the same actionable fix handoff used by the plugin, through REST', async () => {
    const res = await get(`/v1/findings/${f1}/prompt`);
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toContain('Cart crashes');
    expect(res.json().prompt).toContain('Reproduction steps');
    expect(res.json().prompt).toContain(`/runs/${runId}?step=1&finding=${f1}`);
    expect((await get(`/v1/findings/${f1}/prompt`, keyB)).statusCode).toBe(404);
  });

  it('does not leak findings across projects', async () => {
    expect((await get(`/v1/findings/${f1}`, keyB)).statusCode).toBe(404);
    const patch = await app.inject({ method: 'PATCH', url: `/v1/findings/${f1}`, headers: auth(keyB), payload: { status: 'fixed' } });
    expect(patch.statusCode).toBe(404);
  });

  it('PATCH validates status, updates it and feeds noise on dismiss', async () => {
    const patch = (status: unknown) =>
      app.inject({ method: 'PATCH', url: `/v1/findings/${f2}`, headers: auth(keyA), payload: { status } as object });
    expect((await patch('flaky')).statusCode).toBe(400);
    const ok = await patch('dismissed');
    expect(ok.statusCode).toBe(200);
    expect(ApiFindingDetail.parse(ok.json()).status).toBe('dismissed');
    await patch('dismissed');
    const [n] = await db.select().from(noise).where(eq(noise.signature, 'sig2'));
    expect(n!.dismissCount).toBe(1);
    expect((await patch('fixed')).json().status).toBe('fixed');
    await patch('confirmed');
  });
});

describe('scans and runs', () => {
  it('GET /v1/scans/:id has runs, findings and cost', async () => {
    const res = await get(`/v1/scans/${scanId}`);
    expect(res.statusCode).toBe(200);
    const s = ApiScanDetail.parse(res.json());
    expect(s.baseUrl).toBe('http://shop.test');
    expect(s.runs).toHaveLength(1);
    expect(s.findings).toHaveLength(2);
    expect(s.cost.scanUsd).toBe(0.5);
    expect(s.cost.runsUsd).toBeCloseTo(0.2);
    expect(s.cost.llmUsd).toBeCloseTo(0.3);
    expect(s.cost.tokens).toBe(1200);
    expect((await get(`/v1/scans/${scanId}`, keyB)).statusCode).toBe(404);
  });

  it('GET /v1/scans/:id/findings filters', async () => {
    const r = ListFindingsResponse.parse((await get(`/v1/scans/${scanId}/findings?priority=P3`)).json());
    expect(r.findings.map((f) => f.id)).toEqual([f2]);
  });

  it('GET /v1/runs/:id returns steps with outcome and signed screenshot', async () => {
    const run = ApiRun.parse((await get(`/v1/runs/${runId}`)).json());
    expect(run.charter?.goal).toBe('poke around');
    expect(run.steps[0]).toMatchObject({ n: 1, outcome: 'ok', error: null });
    expect(run.steps[0]!.screenshotUrl).toContain('/v1/files/runs/r/s1.png?');
    expect(run.videoUrl).toContain('video.webm');
    expect((await get(`/v1/runs/${runId}`, keyB)).statusCode).toBe(404);
    expect((await get('/v1/runs/nope')).statusCode).toBe(404);
  });

  it('timeline returns stored JSON with signed URLs that the file route serves', async () => {
    const tl = ApiTimeline.parse((await get(`/v1/runs/${runId}/timeline`)).json());
    expect(tl.durationMs).toBe(5000);
    expect(tl.steps[0]!.screenshotUrl).toContain('s1.png');
    const seg = await app.inject({ method: 'GET', url: tl.rrwebSegments[0]!.signedUrl });
    expect(seg.statusCode).toBe(200);
    expect(seg.body).toBe('[]');
  });

  it('rrweb segment redirects to a signed file URL', async () => {
    const res = await get(`/v1/runs/${runId}/rrweb/0`);
    expect(res.statusCode).toBe(302);
    const follow = await app.inject({ method: 'GET', url: res.headers.location as string });
    expect(follow.statusCode).toBe(200);
    expect((await get(`/v1/runs/${runId}/rrweb/7`)).statusCode).toBe(404);
    expect((await get(`/v1/runs/${runId}/rrweb/x`)).statusCode).toBe(400);
  });
});

describe('GET /v1/scans/:id/events', () => {
  it('404 for a scan of another project', async () => {
    expect((await get(`/v1/scans/${scanId}/events`, keyB)).statusCode).toBe(404);
  });

  it('streams scan, run, step and finding events then done when the scan finishes', async () => {
    setTimeout(() => {
      void (async () => {
        await db.update(agentRuns).set({ status: 'done' }).where(eq(agentRuns.id, runId));
        await db.update(scans).set({ status: 'done', finishedAt: new Date() }).where(eq(scans.id, scanId));
      })();
    }, 300);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/v1/scans/${scanId}/events`, { headers: { ...auth(keyA), origin: 'http://dash.test' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://dash.test');
    const text = await res.text();
    const events = text
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => ScanEvent.parse(JSON.parse(chunk.split('\n').find((l) => l.startsWith('data: '))!.slice(6))));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('scan');
    expect(types).toContain('step');
    const step = events.find((e) => e.type === 'step');
    expect(step && step.type === 'step' && step.screenshotUrl).toMatch(/^\/v1\/files\/runs\/r\/s1\.png\?expires=\d+&sig=[0-9a-f]+$/);
    expect(step && step.type === 'step' && step.actionType).toBeTruthy();
    expect(types.filter((t) => t === 'finding')).toHaveLength(2);
    expect(types.at(-1)).toBe('done');
    expect(events.some((e) => e.type === 'run' && e.status === 'done')).toBe(true);
  });
});

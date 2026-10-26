import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, environments, migrate, projects, scans, apiKeys, type Db } from '@gremlin/db';
import { FsStorage } from '@gremlin/storage';
import { buildServer, createApiKey, createQueues, signFilePath, type Queues } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

const url = process.env.DATABASE_URL!;
const schema = `test_${randomBytes(6).toString('hex')}`;
const prefix = `gremlin-test-${randomBytes(6).toString('hex')}`;
let admin: ReturnType<typeof postgres>;
let db: Db;
let queues: Queues;
let app: FastifyInstance;
let storageDir: string;
let storage: FsStorage;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = createDb(url, { schema });
  await migrate(db, { schema });
  queues = createQueues(process.env.REDIS_URL!, { prefix });
  storageDir = await mkdtemp(join(tmpdir(), 'gremlin-engine-'));
  storage = new FsStorage(storageDir);
  app = buildServer({ db, storage, queues });
  await app.ready();
  const [pa] = await db.insert(projects).values({ name: 'a' }).returning();
  const [pb] = await db.insert(projects).values({ name: 'b' }).returning();
  keyA = await createApiKey(db, pa!.id);
  keyB = await createApiKey(db, pb!.id);
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
  await rm(storageDir, { recursive: true, force: true });
});

const post = (body: unknown, key?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/scans',
    payload: body as object,
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

describe('api keys', () => {
  it('returns grm_ + 32 base62 and stores only a hash', async () => {
    expect(keyA).toMatch(/^grm_[0-9A-Za-z]{32}$/);
    const rows = await db.select().from(apiKeys);
    expect(rows.some((r) => r.hash === keyA)).toBe(false);
    expect(rows.some((r) => r.hash === createHash('sha256').update(keyA).digest('hex'))).toBe(true);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
  });
});

describe('healthz', () => {
  it('is unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('POST /v1/scans', () => {
  it('401 without auth', async () => {
    const res = await post({ url: 'http://localhost:3000', authorised: true });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('401 with a wrong key', async () => {
    const res = await post({ url: 'http://localhost:3000', authorised: true }, 'grm_' + 'x'.repeat(32));
    expect(res.statusCode).toBe(401);
  });

  it('400 when authorised is missing or not true', async () => {
    expect((await post({ url: 'http://localhost:3000' }, keyA)).statusCode).toBe(400);
    expect((await post({ url: 'http://localhost:3000', authorised: false }, keyA)).statusCode).toBe(400);
    expect((await post({ url: 'http://localhost:3000', authorised: true, teamSize: 21 }, keyA)).statusCode).toBe(400);
  });

  it('400 for non-http(s) urls', async () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)']) {
      expect((await post({ url: u, authorised: true }, keyA)).statusCode).toBe(400);
    }
  });

  it('malformed JSON: 400 with a key, 401 without', async () => {
    const headers = { 'content-type': 'application/json' };
    const bad = await app.inject({ method: 'POST', url: '/v1/scans', payload: '{nope', headers: { ...headers, authorization: `Bearer ${keyA}` } });
    expect(bad.statusCode).toBe(400);
    const noKey = await app.inject({ method: 'POST', url: '/v1/scans', payload: '{nope', headers });
    expect(noKey.statusCode).toBe(401);
  });

  it('keeps allowedActions per scan and shares one environment', async () => {
    const [p] = await db.insert(projects).values({ name: 'per-scan' }).returning();
    const key = await createApiKey(db, p!.id);
    const r1 = await post({ url: 'http://shared.test/a', authorised: true, allowedActions: 'full' }, key);
    const r2 = await post({ url: 'http://shared.test/b', authorised: true, allowedActions: 'read_only' }, key);
    const id1 = (r1.json() as { scanId: string }).scanId;
    const id2 = (r2.json() as { scanId: string }).scanId;
    const [s1] = await db.select().from(scans).where(eq(scans.id, id1));
    const [s2] = await db.select().from(scans).where(eq(scans.id, id2));
    expect(s1!.allowedActions).toBe('full');
    expect(s2!.allowedActions).toBe('read_only');
    expect(s1!.environmentId).toBe(s2!.environmentId);
    const envs = await db.select().from(environments).where(eq(environments.projectId, p!.id));
    expect(envs).toHaveLength(1);
    const got = await app.inject({ method: 'GET', url: `/v1/scans/${id1}`, headers: { authorization: `Bearer ${key}` } });
    expect(got.json().allowedActions).toBe('full');
  });

  it('201, queued scan, upserted environment, one discovery job', async () => {
    const res = await post({ url: 'http://localhost:3000/some/path?x=1', authorised: true, focus: 'checkout' }, keyA);
    expect(res.statusCode).toBe(201);
    const { scanId } = res.json() as { scanId: string };
    expect(scanId).toBeTruthy();

    const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(scan!.status).toBe('queued');
    expect(scan!.teamSize).toBe(5);
    expect(scan!.focus).toBe('checkout');

    const [env] = await db.select().from(environments).where(eq(environments.id, scan!.environmentId));
    expect(env!.baseUrl).toBe('http://localhost:3000');
    expect(env!.allowedActions).toBe('read_only');

    const jobs = await queues.discovery.getJobs(['waiting', 'delayed', 'active']);
    const mine = jobs.filter((j) => j.data.scanId === scanId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data).toEqual({ scanId });

    // second scan on the same origin reuses the environment row
    const res2 = await post({ url: 'http://localhost:3000', authorised: true, allowedActions: 'full' }, keyA);
    const { scanId: id2 } = res2.json() as { scanId: string };
    const [scan2] = await db.select().from(scans).where(eq(scans.id, id2));
    expect(scan2!.environmentId).toBe(scan!.environmentId);
  });
});

describe('GET /v1/scans/:id', () => {
  it('returns the scan to its owner and 404 to another project', async () => {
    const res = await post({ url: 'http://localhost:4000', authorised: true }, keyA);
    const { scanId } = res.json() as { scanId: string };

    const own = await app.inject({ method: 'GET', url: `/v1/scans/${scanId}`, headers: { authorization: `Bearer ${keyA}` } });
    expect(own.statusCode).toBe(200);
    expect(own.json().status).toBe('queued');
    expect(own.json().id).toBe(scanId);

    const other = await app.inject({ method: 'GET', url: `/v1/scans/${scanId}`, headers: { authorization: `Bearer ${keyB}` } });
    expect(other.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/v1/scans/nope', headers: { authorization: `Bearer ${keyB}` } });
    expect(missing.statusCode).toBe(404);
    expect(other.json()).toEqual(missing.json());

    expect((await app.inject({ method: 'GET', url: `/v1/scans/${scanId}` })).statusCode).toBe(401);
  });

  it('updates last_used_at', async () => {
    const [p] = await db.insert(projects).values({ name: 'lu' }).returning();
    const key = await createApiKey(db, p!.id);
    const hash = createHash('sha256').update(key).digest('hex');
    const [before] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hash));
    expect(before!.lastUsedAt).toBeNull();
    await app.inject({ method: 'GET', url: '/v1/scans/nope', headers: { authorization: `Bearer ${key}` } });
    const [after] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hash));
    expect(after!.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('GET /v1/files/*', () => {
  it('serves with a valid signature, 403 otherwise', async () => {
    await storage.put('runs/r1/shot.png', Buffer.from('png-bytes'), 'image/png');
    const secret = process.env.GREMLIN_SECRET_KEY!;
    const path = signFilePath('runs/r1/shot.png', secret);
    const ok = await app.inject({ method: 'GET', url: path });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('png-bytes');
    expect(ok.headers['content-type']).toBe('image/png');

    const u = new URL(path, 'http://x');
    const exp = u.searchParams.get('expires')!;
    const sig = u.searchParams.get('sig')!;
    const base = '/v1/files/runs/r1/shot.png';
    expect((await app.inject({ method: 'GET', url: `${base}?expires=${exp}&sig=${'0'.repeat(64)}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(403);
    const past = String(Math.floor(Date.now() / 1000) - 10);
    const pastSig = createHmac('sha256', secret).update('runs/r1/shot.png' + past).digest('hex');
    expect((await app.inject({ method: 'GET', url: `${base}?expires=${past}&sig=${pastSig}` })).statusCode).toBe(403);
    // signature for a different key is rejected
    expect((await app.inject({ method: 'GET', url: `/v1/files/runs/r1/other.png?expires=${exp}&sig=${sig}` })).statusCode).toBe(403);
  });

  it('404 for a correctly signed missing object', async () => {
    const path = signFilePath('runs/none.png', process.env.GREMLIN_SECRET_KEY!);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });

  it('never serves content for traversal-ish keys, even when signed', async () => {
    const secret = process.env.GREMLIN_SECRET_KEY!;
    const expires = String(Math.floor(Date.now() / 1000) + 600);
    for (const raw of ['../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', 'runs//r1/shot.png', '..']) {
      const unsigned = await app.inject({ method: 'GET', url: `/v1/files/${raw}` });
      expect([403, 404]).toContain(unsigned.statusCode);
      expect(unsigned.body).not.toContain('root:');
      const key = decodeURIComponent(raw);
      const sig = createHmac('sha256', secret).update(key + expires).digest('hex');
      const signed = await app.inject({ method: 'GET', url: `/v1/files/${raw}?expires=${expires}&sig=${sig}` });
      expect([403, 404]).toContain(signed.statusCode);
      expect(signed.body).not.toContain('root:');
    }
  });

  it('403 for a tampered signature', async () => {
    const path = signFilePath('runs/r1/shot.png', process.env.GREMLIN_SECRET_KEY!);
    const tampered = path.replace(/sig=(.)/, (_m, c: string) => `sig=${c === 'a' ? 'b' : 'a'}`);
    expect((await app.inject({ method: 'GET', url: tampered })).statusCode).toBe(403);
  });
});

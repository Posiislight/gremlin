import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDb, migrate, projects, environments, scans, agentRuns, type Db } from '@gremlin/db';
import { createQueues, closeQueues, type Queues } from '../src/queue.js';
import { discoverScan, finalizeScan } from '../src/orchestrator.js';

const schema = `test_${randomBytes(6).toString('hex')}`;
let admin: ReturnType<typeof postgres>;
let db: Db;
let queues: Queues;
let scanId: string;
beforeAll(async () => {
  admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = createDb(process.env.DATABASE_URL!, { schema });
  await migrate(db, { schema });
  queues = createQueues(process.env.REDIS_URL!, { prefix: schema });
  const [p] = await db.insert(projects).values({ name: 'integration' }).returning();
  const [e] = await db.insert(environments).values({ projectId: p!.id, baseUrl: 'http://shop.test' }).returning();
  const [s] = await db.insert(scans).values({ environmentId: e!.id, teamSize: 2, focus: 'Test the cart' }).returning();
  scanId = s!.id;
});
afterAll(async () => {
  if (queues) {
    for (const q of Object.values(queues)) await q.obliterate({ force: true });
    await closeQueues(queues);
  }
  await db?.close();
  if (admin) { await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
it('dispatches real agent jobs once, preserves the entry path, and settles mixed outcomes', async () => {
  await discoverScan({ db, queues }, { scanId, startPath: '/cart?demo=1' });
  await discoverScan({ db, queues }, { scanId, startPath: '/cart?demo=1' });
  const jobs = await queues.agent.getWaiting();
  expect(jobs).toHaveLength(2);
  expect(jobs[0]!.data.charter).toMatchObject({ goal: 'Test the cart', startPath: '/cart?demo=1' });
  let rows = await db.select().from(agentRuns).where(eq(agentRuns.scanId, scanId));
  expect(rows).toHaveLength(2);
  await finalizeScan(db, scanId);
  expect((await db.select().from(scans).where(eq(scans.id, scanId)))[0]!.status).toBe('scanning');
  await db.update(agentRuns).set({ status: 'finished' }).where(eq(agentRuns.id, rows[0]!.id));
  await db.update(agentRuns).set({ status: 'error' }).where(eq(agentRuns.id, rows[1]!.id));
  await Promise.all([finalizeScan(db, scanId), finalizeScan(db, scanId)]);
  const [done] = await db.select().from(scans).where(eq(scans.id, scanId));
  expect(done!.status).toBe('partial');
  expect(done!.startedAt).toBeTruthy();
  expect(done!.finishedAt).toBeTruthy();
});

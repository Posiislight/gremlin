import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action } from '@gremlin/contract';
import {
  agentRuns,
  createDb,
  environments,
  findings,
  migrate,
  projects,
  scans,
  steps,
  type Db,
} from '../src/index.js';
import { eq } from 'drizzle-orm';

const url = process.env.DATABASE_URL!;
const schema = `test_${randomBytes(6).toString('hex')}`;
let admin: ReturnType<typeof postgres>;
let db: Db;

beforeAll(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  db = createDb(url, { schema });
  await migrate(db, { schema });
});

afterAll(async () => {
  await db?.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

describe('schema', () => {
  it('round-trips project -> environment -> scan -> run -> step', async () => {
    const [project] = await db.insert(projects).values({ name: 'demo' }).returning();
    const [env] = await db
      .insert(environments)
      .values({ projectId: project!.id, baseUrl: 'http://localhost:3000', allowedActions: 'read_only' })
      .returning();
    const [scan] = await db.insert(scans).values({ environmentId: env!.id, status: 'queued' }).returning();
    const [run] = await db.insert(agentRuns).values({ scanId: scan!.id, kind: 'scan', status: 'queued' }).returning();
    const action: Action = { type: 'click', ref: 'e12', intent: 'open the cart' };
    const [step] = await db
      .insert(steps)
      .values({ agentRunId: run!.id, n: 1, actionJson: action, intent: 'open the cart', tMs: 120 })
      .returning();

    const [back] = await db.select().from(steps).where(eq(steps.id, step!.id));
    expect(back!.actionJson).toEqual(action);
    expect(scan!.status).toBe('queued');
    expect(scan!.allowedActions).toBe('read_only');
    expect(run!.kind).toBe('scan');
    expect(project!.createdAt).toBeInstanceOf(Date);
  });

  it('allows a verify run without a scan', async () => {
    const [run] = await db.insert(agentRuns).values({ kind: 'verify', status: 'queued' }).returning();
    const [back] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(back!.scanId).toBeNull();
    expect(back!.kind).toBe('verify');
  });

  it('rejects a duplicate (project_id, signature) finding', async () => {
    const [project] = await db.insert(projects).values({ name: 'dup' }).returning();
    const row = {
      projectId: project!.id,
      signature: 'sig-1',
      priority: 'P1',
      title: 'Cart total NaN',
      expected: 'a number',
      actual: 'NaN',
    };
    await db.insert(findings).values(row);
    await expect(db.insert(findings).values(row)).rejects.toThrow();
  });

  it('keeps tables out of the public schema', async () => {
    const rows = await admin`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'findings'`;
    expect(rows).toHaveLength(0);
  });
});

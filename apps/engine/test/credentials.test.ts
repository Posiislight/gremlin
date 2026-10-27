import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDb, migrate, personas, projects, type Db } from '@gremlin/db';
import { createApiKey, createQueues, mcpRoutes, type Queues } from '../src/index.js';
import {
  decryptCredentials,
  encryptCredentials,
  loadSecrets,
  signCredentialLink,
  verifyCredentialLink,
} from '../src/credentials.js';
import { credentialRoutes } from '../src/routes/credentials.js';
import { FIXTURE_LOGIN, startFixtureServer } from './fixtureServer.js';

const SECRET = 'unit-test-secret';
const PASSWORD = 'Sup3r-Secret-pw!';

describe('credential crypto and links', () => {
  it('round-trips encrypted credentials and fails with a different key', () => {
    const blob = encryptCredentials({ username: 'a@b.test', password: PASSWORD }, SECRET);
    expect(blob).not.toContain(PASSWORD);
    expect(decryptCredentials(blob, SECRET)).toEqual({ username: 'a@b.test', password: PASSWORD });
    expect(() => decryptCredentials(blob, 'other')).toThrow();
  });

  it('signs links that expire and reject tampering', () => {
    const claims = { projectId: 'p', environmentId: 'e', persona: 'default' };
    const t = signCredentialLink(claims, SECRET, 1_000_000);
    expect(verifyCredentialLink(t, SECRET, 1_000_000 + 60_000)).toEqual(claims);
    expect(verifyCredentialLink(t, SECRET, 1_000_000 + 16 * 60_000)).toBeNull();
    expect(verifyCredentialLink(t, 'other', 1_000_000)).toBeNull();
    expect(verifyCredentialLink(`x${t}`, SECRET, 1_000_000)).toBeNull();
    expect(verifyCredentialLink('garbage', SECRET)).toBeNull();
  });
});

describe('credentials via MCP and the secure form', () => {
  const url = process.env.DATABASE_URL!;
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const prefix = `gremlin-test-${randomBytes(6).toString('hex')}`;
  let admin: ReturnType<typeof postgres>;
  let db: Db;
  let queues: Queues;
  let app: FastifyInstance;
  let base: string;
  let client: Client;
  let otherClient: Client;
  let projectId: string;

  async function connect(key: string): Promise<Client> {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return c;
  }
  async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, data: JSON.parse(r.content[0]!.text) as Record<string, any> };
  }
  const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

  beforeAll(async () => {
    admin = postgres(url, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    db = createDb(url, { schema });
    await migrate(db, { schema });
    queues = createQueues(process.env.REDIS_URL!, { prefix });
    app = Fastify({ routerOptions: { maxParamLength: 1024 } });
    app.register(mcpRoutes({ db, queues, secret: SECRET }));
    app.register(credentialRoutes({ db, secret: SECRET }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const [p] = await db.insert(projects).values({ name: 'a' }).returning();
    const [q] = await db.insert(projects).values({ name: 'b' }).returning();
    projectId = p!.id;
    client = await connect(await createApiKey(db, projectId));
    otherClient = await connect(await createApiKey(db, q!.id));
  });

  afterAll(async () => {
    await client?.close();
    await otherClient?.close();
    await app?.close();
    if (queues) await Promise.all([queues.discovery.close(), queues.agent.close(), queues.confirm.close()]);
    await admin?.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it('issues a link, stores the login encrypted, and loads it for agents', async () => {
    const issued = await call(client, 'request_credentials', { url: 'http://127.0.0.1:3100/store.html' });
    expect(issued.isError).toBe(false);
    expect(issued.data.alreadySaved).toBe(false);
    const link = issued.data.link as string;
    expect(link.startsWith(`${base}/credentials/`)).toBe(true);

    const page = await fetch(link);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('type="password"');
    expect(html).toContain('http://127.0.0.1:3100');

    const bad = await fetch(link, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: 'x' }) });
    expect(bad.status).toBe(400);

    const saved = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ username: FIXTURE_LOGIN.email, password: PASSWORD }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('Login saved');

    const [row] = await db.select().from(personas);
    expect(row!.credentialsEnc).toBeTruthy();
    expect(row!.credentialsEnc).not.toContain(PASSWORD);

    const secrets = await loadSecrets(db, issued.data.environmentId, undefined, SECRET);
    expect(secrets).toEqual({ username: FIXTURE_LOGIN.email, email: FIXTURE_LOGIN.email, password: PASSWORD });
    expect(await loadSecrets(db, issued.data.environmentId, undefined, 'wrong-key')).toEqual({});

    const again = await call(client, 'request_credentials', { url: 'http://127.0.0.1:3100/' });
    expect(again.data.alreadySaved).toBe(true);
    expect(again.data.link).toBeUndefined();
    expect(JSON.stringify(again.data)).not.toContain(PASSWORD);

    const started = await call(client, 'start_scan', { url: 'http://127.0.0.1:3100/store.html', teamSize: 1 });
    expect(started.data.loginSaved).toBe(true);
  });

  it('rejects expired or forged links and cross-project environments', async () => {
    const dead = await fetch(`${base}/credentials/not-a-real-token`);
    expect(dead.status).toBe(410);
    const post = await fetch(`${base}/credentials/not-a-real-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ username: 'a', password: 'b' }),
    });
    expect(post.status).toBe(410);

    const [env] = await db.select().from((await import('@gremlin/db')).environments);
    const foreign = await call(otherClient, 'request_credentials', { environmentId: env!.id });
    expect(foreign.isError).toBe(true);
  });
});

describe('fixture login', () => {
  it('gates the members store and cart API behind the demo login', async () => {
    const f = await startFixtureServer();
    try {
      const redirect = await fetch(`${f.url}/store.html`, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      expect((await fetch(`${f.url}/api/cart?auth=1&n=1`, { method: 'POST' })).status).toBe(401);
      expect((await fetch(`${f.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: FIXTURE_LOGIN.email, password: 'no' }) })).status).toBe(401);
      const ok = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(FIXTURE_LOGIN) });
      expect(ok.status).toBe(200);
      const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
      expect((await fetch(`${f.url}/store.html`, { headers: { cookie } })).status).toBe(200);
      expect((await fetch(`${f.url}/api/cart?auth=1&n=1`, { method: 'POST', headers: { cookie } })).status).toBe(200);
      expect((await fetch(`${f.url}/api/cart?auth=1&n=2`, { method: 'POST', headers: { cookie } })).status).toBe(500);
      expect((await fetch(`${f.url}/shop.css`)).headers.get('content-type')).toContain('text/css');
    } finally {
      await f.close();
    }
  });
});

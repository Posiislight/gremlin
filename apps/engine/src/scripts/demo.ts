/** One local stack: real engine, agent workers, fixture target and dashboard; no mock results. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { apiKeys, createDb, migrate, projects } from '@gremlin/db';
import { createStorage } from '@gremlin/storage';
import { createLlm, loadLlmConfig } from '@gremlin/llm';
import { buildServer, createApiKey, createQueues, closeQueues, hashKey } from '../index.js';
import { createUsageSink } from '../persist.js';
import { startWorkers } from '../worker.js';
import { startDiscoveryWorker } from '../orchestrator.js';
import { FIXTURE_LOGIN, startFixtureServer } from '../../test/fixtureServer.js';

const root = resolve(import.meta.dirname, '../../../..');
const dotenv = resolve(root, '.env');
if (existsSync(dotenv)) for (const [key, value] of Object.entries(parseEnv(readFileSync(dotenv, 'utf8')))) process.env[key] ??= value;
for (const key of ['DATABASE_URL', 'REDIS_URL', 'GREMLIN_SECRET_KEY', 'OPENROUTER_API_KEY']) {
  if (!process.env[key]) throw new Error(`${key} must be set in the root .env`);
}
const webUrl = 'http://localhost:3200';
process.env.GREMLIN_WEB_URL = webUrl;
process.env.GREMLIN_WEB_ORIGIN = webUrl;
const db = createDb(process.env.DATABASE_URL!);
await migrate(db);
const keyFile = resolve(root, '.env.demo');
const saved = existsSync(keyFile) ? parseEnv(readFileSync(keyFile, 'utf8')) : {};
let apiKey = saved.GREMLIN_API_KEY;
const [knownKey] = apiKey ? await db.select().from(apiKeys).where(eq(apiKeys.hash, hashKey(apiKey))) : [];
if (!knownKey) {
  const [project] = await db.insert(projects).values({ name: 'Gremlin demo' }).returning();
  apiKey = await createApiKey(db, project!.id);
}
writeFileSync(keyFile, `# Local demo credentials. Do not commit or show this file in the recording.\nGREMLIN_ENGINE_URL=http://localhost:8080\nGREMLIN_WEB_URL=${webUrl}\nGREMLIN_API_KEY=${apiKey}\n`);
const queues = createQueues(process.env.REDIS_URL!);
const storage = createStorage(process.env);
const app = buildServer({ db, queues, storage });
await app.listen({ host: '127.0.0.1', port: 8080 });
const llm = createLlm(loadLlmConfig(process.env), { onUsage: createUsageSink(db) });
const workers = await startWorkers({ db, storage, llm, redisUrl: process.env.REDIS_URL! });
const discovery = await startDiscoveryWorker({ db, queues, redisUrl: process.env.REDIS_URL! });
const fixture = await startFixtureServer(3100);
const targetUrl = `${fixture.url}/cart.html`;
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const web = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'dev', '-p', '3200'], {
  cwd: resolve(root, 'apps/web'), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, NEXT_PUBLIC_GREMLIN_API: 'http://localhost:8080', NEXT_PUBLIC_MOCK: '0',
    GREMLIN_API_KEY: apiKey, GREMLIN_DEMO_TARGET_URL: targetUrl },
});
console.info(`\nGremlin dashboard: ${webUrl}\nEngine + MCP: http://localhost:8080/mcp\nBug fixture: ${targetUrl}\n`);
console.info(`Login-gated store: ${fixture.url}/store.html  (test login: ${FIXTURE_LOGIN.email} / ${FIXTURE_LOGIN.password})
`);
console.info('Project credentials saved to .env.demo (not printed). Use full actions to reproduce the fixture POST failure.');
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  web.kill();
  await discovery.close();
  await workers.close();
  await app.close();
  await closeQueues(queues);
  await fixture.close();
  await db.close();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().then(() => process.exit(0)); });
web.on('exit', () => { if (!closing) void shutdown().then(() => process.exit(1)); });

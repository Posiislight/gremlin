import { createDb } from '@gremlin/db';
import { createLlm, loadLlmConfig } from '@gremlin/llm';
import { createStorage } from '@gremlin/storage';
import { createUsageSink } from './persist.js';
import { startWorkers } from './worker.js';
import { createQueues, closeQueues } from './queue.js';
import { startDiscoveryWorker } from './orchestrator.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** Agent worker process: one shared Chromium, GREMLIN_CONTEXTS_PER_WORKER contexts. Migrations run in main.ts. */
async function main(): Promise<void> {
  const db = createDb(need('DATABASE_URL'));
  const storage = createStorage(process.env);
  const llm = createLlm(loadLlmConfig(process.env), { onUsage: createUsageSink(db) });
  const workers = await startWorkers({ db, storage, llm, redisUrl: need('REDIS_URL') });
  const queues = createQueues(need('REDIS_URL'));
  const discovery = await startDiscoveryWorker({ db, queues, redisUrl: need('REDIS_URL') });
  console.info('agent worker started');

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.info(`agent worker shutting down (${signal})`);
    try {
      await discovery.close();
      await workers.close();
      await closeQueues(queues);
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { createDb, migrate } from '@gremlin/db';
import { createStorage } from '@gremlin/storage';
import { buildServer, closeQueues, createQueues } from './index.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const db = createDb(need('DATABASE_URL'));
  await migrate(db);
  const storage = createStorage(process.env);
  const queues = createQueues(need('REDIS_URL'));
  const app = buildServer({ db, storage, queues });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeQueues(queues);
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

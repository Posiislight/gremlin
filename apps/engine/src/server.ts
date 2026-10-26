import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '@gremlin/db';
import type { Storage } from '@gremlin/storage';
import { fileRoutes } from './routes/files.js';
import { scanRoutes } from './routes/scans.js';
import type { Queues } from './queue.js';

export interface ServerDeps {
  db: Db;
  storage: Storage;
  queues: Queues;
  /** HMAC key for signed file paths; defaults to GREMLIN_SECRET_KEY. */
  secret?: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const secret = deps.secret ?? process.env.GREMLIN_SECRET_KEY;
  if (!secret) throw new Error('GREMLIN_SECRET_KEY is required');
  const app = Fastify({ logger: !process.env.VITEST });

  app.get('/healthz', async () => ({ ok: true }));
  app.register(scanRoutes({ db: deps.db, queues: deps.queues }));
  app.register(fileRoutes({ storage: deps.storage, secret }));
  return app;
}

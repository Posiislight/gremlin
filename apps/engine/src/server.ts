import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '@gremlin/db';
import type { Storage } from '@gremlin/storage';
import { fileRoutes } from './routes/files.js';
import { scanRoutes } from './routes/scans.js';
import { apiRoutes } from './routes/api.js';
import { eventRoutes } from './routes/events.js';
import { registerCors } from './cors.js';
import { mcpRoutes } from './mcp/index.js';
import type { Queues } from './queue.js';

export interface ServerDeps {
  db: Db;
  storage: Storage;
  queues: Queues;
  /** HMAC key for signed file paths; defaults to GREMLIN_SECRET_KEY. */
  secret?: string;
  /** Dashboard origin(s) allowed by CORS; defaults to GREMLIN_WEB_ORIGIN, then `*`. */
  webOrigin?: string;
  /** SSE poll interval (ms); default 1000. */
  eventPollMs?: number;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const secret = deps.secret ?? process.env.GREMLIN_SECRET_KEY;
  if (!secret) throw new Error('GREMLIN_SECRET_KEY is required');
  const app = Fastify({ logger: !process.env.VITEST });

  const webOrigin = deps.webOrigin ?? process.env.GREMLIN_WEB_ORIGIN;
  registerCors(app, webOrigin);

  app.get('/healthz', async () => ({ ok: true }));
  app.register(scanRoutes({ db: deps.db, queues: deps.queues }));
  app.register(apiRoutes({ db: deps.db, storage: deps.storage, secret }));
  app.register(
    eventRoutes({ db: deps.db, webOrigin, ...(deps.eventPollMs ? { pollMs: deps.eventPollMs } : {}) }),
  );
  app.register(mcpRoutes({ db: deps.db, queues: deps.queues }));
  app.register(fileRoutes({ storage: deps.storage, secret }));
  return app;
}

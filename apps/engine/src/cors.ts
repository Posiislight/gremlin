import type { FastifyInstance } from 'fastify';

const ALLOW_HEADERS = 'authorization, content-type, last-event-id';
const ALLOW_METHODS = 'GET, POST, PATCH, OPTIONS';

/** Returns the Access-Control-Allow-Origin value for a request origin, or null when not allowed. */
export function allowedOrigin(configured: string | undefined, origin: string | undefined): string | null {
  const setting = (configured ?? '*').trim();
  if (setting === '*' || setting === '') return '*';
  const list = setting.split(',').map((s) => s.trim().replace(/\/$/, ''));
  return origin && list.includes(origin) ? origin : null;
}

/** CORS for the dashboard. `GREMLIN_WEB_ORIGIN` is `*` (default), one origin, or a comma-separated list. */
export function corsHeaders(configured: string | undefined, origin: string | undefined): Record<string, string> {
  const allow = allowedOrigin(configured, origin);
  if (!allow) return {};
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': ALLOW_HEADERS,
    'access-control-allow-methods': ALLOW_METHODS,
    'access-control-max-age': '600',
    ...(allow === '*' ? {} : { vary: 'Origin' }),
  };
}

export function registerCors(app: FastifyInstance, configured: string | undefined): void {
  app.addHook('onRequest', async (req, reply) => {
    const headers = corsHeaders(configured, req.headers.origin);
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });
}

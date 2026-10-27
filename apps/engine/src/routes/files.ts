import { createHmac, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Storage } from '@gremlin/storage';

const TTL_SECONDS = 3600;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const sign = (key: string, expires: string, secret: string) =>
  createHmac('sha256', secret).update(key + expires).digest('hex');

/** Returns `/v1/files/<key>?expires=<unix seconds>&sig=<hex hmac-sha256(key + expires)>`, valid for 1h. */
export function signFilePath(key: string, secret: string, now: number = Date.now()): string {
  const expires = String(Math.floor(now / 1000) + TTL_SECONDS);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `/v1/files/${encoded}?expires=${expires}&sig=${sign(key, expires, secret)}`;
}

function validSignature(key: string, expires: unknown, sig: unknown, secret: string): boolean {
  if (typeof expires !== 'string' || typeof sig !== 'string' || !/^\d+$/.test(expires)) return false;
  if (Number(expires) * 1000 < Date.now()) return false;
  const expected = Buffer.from(sign(key, expires, secret));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function fileRoutes(deps: { storage: Storage; secret: string }) {
  return async function (app: FastifyInstance): Promise<void> {
    app.get<{ Params: { '*': string }; Querystring: { expires?: string; sig?: string } }>(
      '/v1/files/*',
      async (req, reply) => {
        const key = req.params['*'];
        if (!validSignature(key, req.query.expires, req.query.sig, deps.secret)) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        try {
          if (!(await deps.storage.exists(key))) return reply.code(404).send({ error: 'not_found' });
          const body = await deps.storage.get(key);
          return reply
            .header('content-type', CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream')
            .header('cache-control', 'private, max-age=3600')
            .send(body);
        } catch {
          return reply.code(404).send({ error: 'not_found' });
        }
      },
    );
  };
}

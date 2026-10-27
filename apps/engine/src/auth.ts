import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiKeys, type Db } from '@gremlin/db';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

declare module 'fastify' {
  interface FastifyRequest {
    projectId: string;
  }
}

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    // rejection sampling: 248 = 62 * 4, so bytes below it map uniformly
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += BASE62[b % 62];
    }
  }
  return out;
}

/** Creates an API key for the project. The plaintext is returned once; only its sha256 is stored. */
export async function createApiKey(db: Db, projectId: string): Promise<string> {
  const key = `grm_${randomBase62(32)}`;
  await db.insert(apiKeys).values({ projectId, hash: hashKey(key) });
  return key;
}

export function authenticate(db: Db) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) return void reply.code(401).send({ error: 'unauthorized' });
    const hash = hashKey(match[1]!);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).limit(1);
    if (!row) return void reply.code(401).send({ error: 'unauthorized' });
    req.projectId = row.projectId;
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  };
}

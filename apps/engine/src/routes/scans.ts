import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { environments, scans, type Db } from '@gremlin/db';
import { authenticate } from '../auth.js';
import type { Queues } from '../queue.js';

const httpUrl = z.url({ protocol: /^https?$/ });

export const createScanBody = z.object({
  url: httpUrl,
  teamSize: z.number().int().min(1).max(20).default(5),
  focus: z.string().min(1).max(500).optional(),
  allowedActions: z.enum(['read_only', 'full']).default('read_only'),
  authorised: z.literal(true),
});

export function scanRoutes(deps: { db: Db; queues: Queues }) {
  const { db, queues } = deps;
  return async function (app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticate(db));

    app.post('/v1/scans', async (req, reply) => {
      const parsed = createScanBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const body = parsed.data;
      const origin = new URL(body.url).origin;
      const projectId = req.projectId;

      const scanId = await db.transaction(async (tx) => {
        // Serialise concurrent upserts for the same (project, origin); there is no unique index.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId + '|' + origin}))`);
        const [existing] = await tx
          .select()
          .from(environments)
          .where(and(eq(environments.projectId, projectId), eq(environments.baseUrl, origin)))
          .limit(1);
        let environmentId: string;
        if (existing) {
          environmentId = existing.id;
        } else {
          const [env] = await tx
            .insert(environments)
            .values({ projectId, baseUrl: origin, allowedActions: body.allowedActions })
            .returning();
          environmentId = env!.id;
        }
        const [scan] = await tx
          .insert(scans)
          .values({
            environmentId,
            status: 'queued',
            teamSize: body.teamSize,
            allowedActions: body.allowedActions,
            focus: body.focus ?? null,
          })
          .returning();
        return scan!.id;
      });

      const entry = new URL(body.url);
      await queues.discovery.add('discover', { scanId, startPath: `${entry.pathname}${entry.search}` });
      return reply.code(201).send({ scanId });
    });
  };
}

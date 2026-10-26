import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { environments, scans, type Db } from '@gremlin/db';
import { authenticate } from '../auth.js';
import type { Queues } from '../queue.js';

const httpUrl = z.url().refine((u) => /^https?:$/.test(new URL(u).protocol), 'url must be http(s)');

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
    app.addHook('preHandler', authenticate(db));

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
          if (existing.allowedActions !== body.allowedActions) {
            await tx
              .update(environments)
              .set({ allowedActions: body.allowedActions })
              .where(eq(environments.id, existing.id));
          }
        } else {
          const [env] = await tx
            .insert(environments)
            .values({ projectId, baseUrl: origin, allowedActions: body.allowedActions })
            .returning();
          environmentId = env!.id;
        }
        const [scan] = await tx
          .insert(scans)
          .values({ environmentId, status: 'queued', teamSize: body.teamSize, focus: body.focus ?? null })
          .returning();
        return scan!.id;
      });

      await queues.discovery.add('discover', { scanId });
      return reply.code(201).send({ scanId });
    });

    app.get<{ Params: { id: string } }>('/v1/scans/:id', async (req, reply) => {
      const [row] = await db
        .select({ scan: scans })
        .from(scans)
        .innerJoin(environments, eq(scans.environmentId, environments.id))
        .where(and(eq(scans.id, req.params.id), eq(environments.projectId, req.projectId)))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return row.scan;
    });
  };
}

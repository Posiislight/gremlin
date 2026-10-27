import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScanEvent } from '@gremlin/contract';
import { agentRuns, findings, scans, steps, type Db } from '@gremlin/db';
import { authenticate } from '../auth.js';
import { inScan } from '../scan-findings.js';
import { corsHeaders } from '../cors.js';
import { ownedScan } from './access.js';
import { signFilePath } from './files.js';
import { summarizeFindings } from './serialize.js';

const TERMINAL = new Set(['done', 'partial', 'failed', 'error', 'completed', 'cancelled']);
const MAX_STREAM_MS = 60 * 60 * 1000;

export interface EventsOptions {
  db: Db;
  webOrigin: string | undefined;
  /** HMAC secret for signed screenshot URLs. */
  secret?: string;
  pollMs?: number;
}

/** GET /v1/scans/:id/events: Server-Sent Events built by polling the DB; each message is a ScanEvent. */
export function eventRoutes(opts: EventsOptions) {
  const { db } = opts;
  const pollMs = opts.pollMs ?? 1000;
  return async function (app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticate(db));

    app.get('/v1/scans/:id/events', async (req, reply) => {
      const p = z.object({ id: z.string().min(1).max(128) }).safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'invalid_request', issues: p.error.issues });
      const scanId = p.data.id;
      if (!(await ownedScan(db, req.projectId, scanId))) return reply.code(404).send({ error: 'not_found' });

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...corsHeaders(opts.webOrigin, req.headers.origin),
      });

      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      const send = (e: ScanEvent) => {
        if (!closed) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };

      const lastScan = { sig: '' };
      const runSig = new Map<string, string>();
      const seenSteps = new Set<string>();
      const findingSig = new Map<string, string>();
      const started = Date.now();

      const tick = async (): Promise<boolean> => {
        const [scan] = await db.select().from(scans).where(eq(scans.id, scanId)).limit(1);
        if (!scan) return true;
        const sig = `${scan.status}|${scan.costUsd}`;
        if (sig !== lastScan.sig) {
          lastScan.sig = sig;
          send({ type: 'scan', scanId, status: scan.status, costUsd: scan.costUsd });
        }
        const runs = await db.select().from(agentRuns).where(eq(agentRuns.scanId, scanId)).orderBy(asc(agentRuns.t0));
        for (const r of runs) {
          const s = `${r.status}|${r.error ?? ''}`;
          if (runSig.get(r.id) !== s) {
            runSig.set(r.id, s);
            send({ type: 'run', runId: r.id, kind: r.kind, status: r.status, error: r.error });
          }
        }
        if (runs.length) {
          const rows = await db
            .select()
            .from(steps)
            .where(inArray(steps.agentRunId, runs.map((r) => r.id)))
            .orderBy(asc(steps.agentRunId), asc(steps.n));
          for (const s of rows) {
            if (seenSteps.has(s.id)) continue;
            seenSteps.add(s.id);
            send({
              type: 'step', runId: s.agentRunId, stepId: s.id, n: s.n, intent: s.intent, outcome: s.outcome, tMs: s.tMs,
              screenshotUrl: s.screenshotKey && opts.secret ? signFilePath(s.screenshotKey, opts.secret) : null,
              actionType: s.actionJson?.type ?? null,
            });
          }
        }
        const finds = await summarizeFindings(db, await db.select().from(findings).where(inScan(scanId)));
        for (const f of finds) {
          const s = `${f.status}|${f.priority}|${f.title}|${f.occurrenceCount}`;
          if (findingSig.get(f.id) !== s) {
            findingSig.set(f.id, s);
            send({ type: 'finding', finding: f });
          }
        }
        const runsSettled = runs.every((r) => r.status !== 'running' && r.status !== 'queued');
        if ((TERMINAL.has(scan.status) || scan.finishedAt) && runsSettled) {
          send({ type: 'done', status: scan.status });
          return true;
        }
        return false;
      };

      try {
        while (!closed && Date.now() - started < MAX_STREAM_MS) {
          if (await tick()) break;
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } catch (err) {
        app.log.error({ err }, 'scan events stream failed');
      } finally {
        if (!res.writableEnded) res.end();
      }
    });
  };
}

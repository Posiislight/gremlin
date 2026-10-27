import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import { Charter } from '@gremlin/contract';
import { agentRuns, type Db } from '@gremlin/db';
import type { Llm } from '@gremlin/llm';
import type { Storage } from '@gremlin/storage';
import { processAgentJob, type AgentJob } from './persist.js';
import { connectionFromUrl } from './queue.js';

export const AgentJobData = z.object({ scanId: z.string().min(1), runId: z.string().min(1), charter: Charter });

export type WorkerDeps = {
  db: Db;
  storage: Storage;
  /** Create with `onUsage: createUsageSink(db)` so llm_usage rows are written. */
  llm: Llm;
  redisUrl: string;
  /** BullMQ key prefix (tests use a unique one). */
  prefix?: string;
  /** Parallel agent contexts over the one shared Chromium. Default: GREMLIN_CONTEXTS_PER_WORKER or 3. */
  concurrency?: number;
  launchBrowser?: () => Promise<Browser>;
  log?: Pick<Console, 'info' | 'error'>;
};

export type Workers = {
  worker: Worker<AgentJob>;
  /** The shared Chromium currently in use. */
  browser(): Browser;
  /** Stops taking jobs, waits for running ones, then closes the browser. Idempotent. */
  close(): Promise<void>;
};

export function contextsPerWorker(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.GREMLIN_CONTEXTS_PER_WORKER);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

const defaultLaunch = () => chromium.launch({ headless: true });

/** Consumes the `agent` queue with K concurrent contexts over one shared Chromium (spec §8.3). */
export async function startWorkers(deps: WorkerDeps): Promise<Workers> {
  const log = deps.log ?? console;
  const launch = deps.launchBrowser ?? defaultLaunch;
  let browser = await launch();
  let relaunching: Promise<Browser> | null = null;

  /** The shared browser; relaunched once if it crashed (concurrent jobs share the relaunch). */
  const getBrowser = async (): Promise<Browser> => {
    if (browser.isConnected()) return browser;
    relaunching ??= launch().then((b) => {
      browser = b;
      relaunching = null;
      return b;
    });
    return relaunching;
  };

  const processor = async (job: Job<AgentJob>): Promise<void> => {
    const parsed = AgentJobData.safeParse(job.data);
    if (!parsed.success) {
      const runId = (job.data as { runId?: unknown } | undefined)?.runId;
      const message = `invalid agent job: ${z.prettifyError(parsed.error).slice(0, 500)}`;
      if (typeof runId === 'string' && runId) {
        await deps.db
          .update(agentRuns)
          .set({ status: 'error', error: message })
          .where(eq(agentRuns.id, runId))
          .catch(() => undefined);
      }
      throw new Error(message);
    }
    // processAgentJob marks the run 'error' (with message) itself and rethrows; BullMQ records the failure.
    await processAgentJob(
      { db: deps.db, storage: deps.storage, llm: deps.llm, browser: await getBrowser() },
      parsed.data,
    );
  };

  const worker = new Worker<AgentJob>('agent', processor, {
    connection: connectionFromUrl(deps.redisUrl),
    concurrency: deps.concurrency ?? contextsPerWorker(),
    ...(deps.prefix ? { prefix: deps.prefix } : {}),
  });
  // A worker 'error' event without a listener would crash the process.
  worker.on('error', (e) => log.error('[agent worker] error', e));
  worker.on('failed', (job, e) => log.error(`[agent worker] job ${job?.id ?? '?'} failed: ${e.message}`));
  await worker.waitUntilReady();

  let closed: Promise<void> | null = null;
  return {
    worker,
    browser: () => browser,
    close() {
      closed ??= (async () => {
        await worker.close().catch((e: unknown) => log.error('[agent worker] close failed', e));
        await relaunching?.catch(() => undefined);
        await browser.close().catch(() => undefined);
      })();
      return closed;
    },
  };
}

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import type { BrowserContext, ConsoleMessage, Page, Request, WebError } from 'playwright';
import type { ReplayTimeline, Signal, Step } from '@gremlin/contract';
import type { Storage } from '@gremlin/storage';
import { sameOrigin } from '../url.js';
import { EMIT_BINDING, FLUSH_FN, rrwebInitScript } from './rrweb-inject.js';
import { buildTimeline } from './timeline.js';

export { buildTimeline } from './timeline.js';

export type RecorderOptions = {
  runId: string;
  /** `Date.now()` captured immediately after `browser.newContext()`; every stream is stamped relative to it. */
  t0: number;
  storage: Storage;
  /** Keys are written under this prefix, e.g. `scans/{scanId}/runs/{runId}`. */
  keyPrefix: string;
  /** Directory the context records video into (`recordVideo.dir`); also used for the trace. */
  tmpDir: string;
  secrets: Record<string, string>;
  /** Target origin: same-origin XHR/fetch bodies are captured. */
  origin: string;
};

export type Recorder = {
  t0: number;
  now(): number;
  /** Signals seen since the previous call. */
  drainSignals(): Signal[];
  addStep(step: Step): void;
  addFinding(id: string, tMs: number): void;
  /** Flush rrweb, finish the trace and video (closes the context's pages), store everything, return the keys. */
  stop(): Promise<{ timelineKey: string; videoKey?: string; traceKey: string; rrwebKeys: string[] }>;
};

const MASK = '•••';
const BODY_LIMIT = 64 * 1024;
const BINARY_BODY = /^(image|video|audio|font)\/|^application\/(octet-stream|zip|pdf)/i;

type Scrubber = { text(s: string): string; bytes(b: Buffer): Buffer };

/** Masks each secret in raw, JSON-escaped and URL-encoded form, in strings and in raw bytes. */
function makeScrubber(secrets: Record<string, string>): Scrubber {
  const forms = new Set<string>();
  for (const v of Object.values(secrets)) {
    if (!v) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
  }
  const needles = [...forms].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
  const latin = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
  return {
    text(s) {
      let out = s;
      for (const n of needles) if (out.includes(n)) out = out.split(n).join(MASK);
      return out;
    },
    bytes(b) {
      let out: string | null = null;
      for (const n of needles) {
        const l = latin(n);
        const cur: string = out ?? b.toString('latin1');
        if (cur.includes(l)) out = cur.split(l).join(latin(MASK));
      }
      return out === null ? b : Buffer.from(out, 'latin1');
    },
  };
}

type Segment = { url: string; parts: string[]; startTs: number; endTs: number };

export async function startRecording(context: BrowserContext, opts: RecorderOptions): Promise<Recorder> {
  const { runId, t0, storage, keyPrefix, tmpDir, origin } = opts;
  const scrub = makeScrubber(opts.secrets);
  const now = () => Date.now() - t0;

  const allSignals: Signal[] = [];
  let pending: Signal[] = [];
  const steps: Step[] = [];
  const findings: { id: string; tMs: number }[] = [];
  const segments = new Map<string, Segment>();
  const pages: Page[] = [];
  const bodyJobs = new Set<Promise<void>>();
  let bodyCount = 0;
  let stopped: Promise<Awaited<ReturnType<Recorder['stop']>>> | null = null;
  let live = true;

  const push = (s: Signal) => {
    if (!live) return;
    allSignals.push(s);
    pending.push(s);
  };

  // rrweb: one segment per document load; events arrive through the binding in 250 ms batches.
  await context.exposeBinding(EMIT_BINDING, (_src, payload: unknown) => {
    if (!live || !payload || typeof payload !== 'object') return;
    const p = payload as { seg?: unknown; url?: unknown; events?: unknown };
    if (typeof p.seg !== 'string' || !Array.isArray(p.events)) return;
    let seg = segments.get(p.seg);
    if (!seg) {
      seg = { url: scrub.text(typeof p.url === 'string' ? p.url : ''), parts: [], startTs: Infinity, endTs: -Infinity };
      segments.set(p.seg, seg);
    }
    for (const ev of p.events as { timestamp?: unknown }[]) {
      if (typeof ev?.timestamp !== 'number') continue;
      seg.startTs = Math.min(seg.startTs, ev.timestamp);
      seg.endTs = Math.max(seg.endTs, ev.timestamp);
      seg.parts.push(scrub.text(JSON.stringify(ev)));
    }
  });
  await context.addInitScript({ content: rrwebInitScript() });

  // trace
  await context.tracing.start({ screenshots: true, snapshots: true });

  // console / page errors
  context.on('console', (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    push({
      kind: 'console',
      level: type,
      text: scrub.text(msg.text()),
      ...(loc.url ? { location: scrub.text(`${loc.url}:${loc.lineNumber}:${loc.columnNumber}`) } : {}),
      tMs: now(),
    });
  });
  context.on('weberror', (we: WebError) => {
    const err = we.error();
    push({
      kind: 'pageerror',
      message: scrub.text(err.message),
      ...(err.stack ? { stack: scrub.text(err.stack) } : {}),
      tMs: now(),
    });
  });

  // network
  const started = new WeakMap<Request, number>();
  const track = (job: Promise<void>) => {
    bodyJobs.add(job);
    void job.finally(() => bodyJobs.delete(job));
  };
  context.on('request', (req) => {
    started.set(req, Date.now());
  });
  const networkSignal = async (req: Request, failed: boolean): Promise<void> => {
    const url = req.url();
    if (/^(data|blob):/i.test(url)) return;
    const startedAt = started.get(req) ?? Date.now();
    const base = {
      kind: 'network' as const,
      method: req.method(),
      url: scrub.text(url),
      resourceType: req.resourceType(),
      durationMs: Date.now() - startedAt,
      tMs: startedAt - t0,
    };
    if (failed) {
      push({ ...base, status: null, failure: scrub.text(req.failure()?.errorText ?? 'failed') });
      return;
    }
    const res = await req.response().catch(() => null);
    if (!res) {
      push({ ...base, status: null, failure: 'no response' });
      return;
    }
    const status = res.status();
    let bodyKey: string | undefined;
    const wanted = status >= 400 || ((base.resourceType === 'xhr' || base.resourceType === 'fetch') && sameOrigin(url, origin));
    if (wanted && !BINARY_BODY.test(res.headers()['content-type'] ?? '')) {
      try {
        const body = (await res.body()).subarray(0, BODY_LIMIT);
        bodyKey = `${keyPrefix}/bodies/${bodyCount++}.txt`;
        await storage.put(bodyKey, Buffer.from(scrub.text(body.toString('utf8')), 'utf8'), 'text/plain; charset=utf-8');
      } catch {
        bodyKey = undefined; // redirects and aborted bodies have none
      }
    }
    push({ ...base, status, durationMs: Date.now() - startedAt, ...(bodyKey ? { bodyKey } : {}) });
  };
  context.on('requestfinished', (req) => track(networkSignal(req, false).catch(() => undefined)));
  context.on('requestfailed', (req) => track(networkSignal(req, true).catch(() => undefined)));

  // navigations (pushState included) and the pages whose video we keep
  const attach = (page: Page) => {
    pages.push(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      push({ kind: 'navigation', url: scrub.text(url), tMs: now() });
    });
  };
  for (const p of context.pages()) attach(p);
  context.on('page', attach);

  async function sanitizeTrace(path: string): Promise<Buffer> {
    const raw = await readFile(path);
    const files = unzipSync(new Uint8Array(raw));
    const out: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(files)) out[name] = scrub.bytes(Buffer.from(data));
    return Buffer.from(zipSync(out, { level: 1 }));
  }

  async function doStop() {
    // let in-flight batches and bodies land
    for (const p of context.pages()) await p.evaluate(`window.${FLUSH_FN}?.()`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    while (bodyJobs.size > 0) await Promise.allSettled([...bodyJobs]);
    const durationMs = now();

    const tracePath = join(tmpDir, `${runId}-trace.zip`);
    await context.tracing.stop({ path: tracePath });

    const videos = pages.map((p) => p.video()).filter((v): v is NonNullable<typeof v> => v !== null);
    for (const p of context.pages()) await p.close().catch(() => undefined);
    live = false;

    const rrwebSegments: ReplayTimeline['rrwebSegments'] = [];
    const rrwebKeys: string[] = [];
    const ordered = [...segments.values()].filter((s) => s.parts.length > 0).sort((a, b) => a.startTs - b.startTs);
    for (const [index, seg] of ordered.entries()) {
      const key = `${keyPrefix}/rrweb/${index}.json`;
      await storage.put(key, Buffer.from(`[${seg.parts.join(',')}]`, 'utf8'), 'application/json');
      rrwebKeys.push(key);
      rrwebSegments.push({ index, startMs: seg.startTs - t0, endMs: seg.endTs - t0, url: seg.url, key });
    }

    let videoKey: string | undefined;
    if (videos[0]) {
      const videoPath = join(tmpDir, `${runId}.webm`);
      await videos[0].saveAs(videoPath);
      videoKey = `${keyPrefix}/video.webm`;
      await storage.put(videoKey, await readFile(videoPath), 'video/webm');
    }

    const traceKey = `${keyPrefix}/trace.zip`;
    await storage.put(traceKey, await sanitizeTrace(tracePath), 'application/zip');

    const timeline = buildTimeline({
      runId,
      t0,
      durationMs,
      ...(videoKey ? { videoKey } : {}),
      traceKey,
      rrwebSegments,
      steps,
      signals: allSignals,
      findings,
    });
    const timelineKey = `${keyPrefix}/timeline.json`;
    await storage.put(timelineKey, Buffer.from(JSON.stringify(timeline), 'utf8'), 'application/json');
    return { timelineKey, ...(videoKey ? { videoKey } : {}), traceKey, rrwebKeys };
  }

  return {
    t0,
    now,
    drainSignals() {
      const out = pending;
      pending = [];
      return out;
    },
    addStep(step) {
      steps.push(JSON.parse(scrub.text(JSON.stringify(step))) as Step);
    },
    addFinding(id, tMs) {
      findings.push({ id, tMs });
    },
    stop() {
      stopped ??= doStop();
      return stopped;
    },
  };
}

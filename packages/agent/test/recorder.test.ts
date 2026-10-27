import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { Browser } from 'playwright';
import { ReplayTimeline, type Action, type Step } from '@gremlin/contract';
import { FsStorage } from '@gremlin/storage';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { createAgentContext } from '../src/context.js';
import { observe } from '../src/observe.js';
import { execute, type ExecContext } from '../src/execute.js';
import { startRecording } from '../src/recorder/index.js';

const PASSWORD = 'hunter2-s3cr3t';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let work: string;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  work = await mkdtemp(join(tmpdir(), 'gremlin-rec-'));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

describe('recorder', () => {
  it('records video, trace, rrweb, console and network on one clock, and leaks no secret', async () => {
    const storageDir = join(work, 'storage');
    const tmpDir = join(work, 'tmp');
    const storage = new FsStorage(storageDir);
    const keyPrefix = 'scans/s1/runs/r1';
    const secrets = { password: PASSWORD };

    const t0 = Date.now();
    const { context, page } = await createAgentContext(browser, {
      recordVideo: { dir: tmpDir, size: { width: 1280, height: 800 } },
      viewport: { width: 1280, height: 800 },
    });
    const rec = await startRecording(context, { runId: 'r1', t0, storage, keyPrefix, tmpDir, secrets, origin: server.url });
    const ectx: ExecContext = {
      secrets,
      origin: server.url,
      fixturesDir: join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
    };

    await page.goto(`${server.url}/actions.html`);
    await page.waitForLoadState('load');
    await page.evaluate(
      `window.__firstAct = 0; for (const t of ['click', 'input', 'keydown']) document.addEventListener(t, () => { if (!window.__firstAct) window.__firstAct = Date.now(); }, true);`,
    );

    const steps: Step[] = [];
    async function run(n: number, build: (ref: (name: string) => Promise<string>) => Promise<Action>): Promise<void> {
      const obs = await observe(page);
      const ref = async (name: string) => {
        const i = (await observe(page)).interactables.find((x) => x.name === name);
        if (!i) throw new Error(`no interactable ${name}`);
        return i.ref;
      };
      const action = await build(ref);
      // A step is stamped when its first DOM event is dispatched in the page (execute() has its own 0.2-0.7 s of
      // pre-dispatch work, which is not clock skew); fall back to the call time if nothing fired.
      const calledAt = rec.now();
      await page.evaluate('window.__firstAct = 0');
      const r = await execute(page, action, ectx);
      const act = (await page.evaluate('window.__firstAct')) as number;
      const tMs = act > 0 ? act - t0 : calledAt;
      const step: Step = {
        n,
        action,
        locator: r.locator,
        intent: action.intent,
        tMs,
        stateHash: obs.stateHash,
        signals: rec.drainSignals(),
        outcome: r.outcome,
        ...(r.error ? { error: r.error } : {}),
      };
      steps.push(step);
      rec.addStep(step);
      expect(r.outcome).toBe('ok');
    }

    await run(1, async (ref) => ({ type: 'click', ref: await ref('Increment'), intent: 'bump counter' }));
    await run(2, async (ref) => ({ type: 'type', ref: await ref('Message'), text: '{{password}}', submit: true, intent: 'send message' }));
    await page.waitForFunction("document.getElementById('result').textContent.length > 0");
    await run(3, async (ref) => ({ type: 'click', ref: await ref('Plain Button'), intent: 'bump by ten' }));

    await page.evaluate(() => console.error('recorder-console-boom'));
    await page.evaluate(() => fetch('/api/500').then(() => undefined));
    await expect
      .poll(() => page.evaluate("performance.getEntriesByName(location.origin + '/api/500').length > 0"))
      .toBe(true);

    rec.addFinding('f1', rec.now());
    const stopped = await rec.stop();

    // timeline parses and is stored
    const timeline = ReplayTimeline.parse(JSON.parse((await storage.get(stopped.timelineKey)).toString('utf8')));
    expect(timeline.runId).toBe('r1');
    expect(timeline.t0).toBe(t0);
    expect(timeline.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(timeline.findings).toEqual([{ id: 'f1', tMs: expect.any(Number) }]);

    // video + trace
    expect(stopped.videoKey).toBeTruthy();
    expect((await storage.get(stopped.videoKey!)).length).toBeGreaterThan(0);
    expect(timeline.videoKey).toBe(stopped.videoKey);
    expect(stopped.traceKey).toBeTruthy();
    const zip = unzipSync(new Uint8Array(await storage.get(stopped.traceKey)));
    expect(Object.keys(zip).length).toBeGreaterThan(0);
    expect(timeline.traceKey).toBe(stopped.traceKey);

    // rrweb segments
    expect(stopped.rrwebKeys.length).toBeGreaterThanOrEqual(1);
    expect(timeline.rrwebSegments.length).toBe(stopped.rrwebKeys.length);
    const events: { timestamp: number }[] = [];
    for (const k of stopped.rrwebKeys) events.push(...(JSON.parse((await storage.get(k)).toString('utf8')) as { timestamp: number }[]));
    expect(events.length).toBeGreaterThan(0);

    // console + network signals
    expect(timeline.signals.some((s) => s.kind === 'console' && s.level === 'error' && s.text.includes('recorder-console-boom'))).toBe(true);
    const net = timeline.signals.find((s) => s.kind === 'network' && s.url.endsWith('/api/500'));
    expect(net).toBeTruthy();
    expect(net && net.kind === 'network' ? net.status : null).toBe(500);
    expect(net && net.kind === 'network' ? net.bodyKey : undefined).toBeTruthy();
    const body = (await storage.get((net as { bodyKey: string }).bodyKey)).toString('utf8');
    expect(body).toContain('boom');
    expect([...timeline.signals].map((s) => s.tMs)).toEqual([...timeline.signals].map((s) => s.tMs).sort((a, b) => a - b));

    // alignment: each step starts within 100 ms of the first rrweb event after it
    events.sort((a, b) => a.timestamp - b.timestamp);
    for (const s of timeline.steps) {
      const first = events.find((e) => e.timestamp - t0 >= s.tMs);
      expect(first, `rrweb event after step ${s.n}`).toBeTruthy();
      expect(Math.abs(first!.timestamp - t0 - s.tMs), `step ${s.n} offset`).toBeLessThanOrEqual(100);
    }

    // the typed secret is in no stored artifact (trace entries inspected after unzipping), but capture did happen
    const echo = timeline.signals.find((s) => s.kind === 'network' && s.url.endsWith('/api/echo'));
    expect(echo && echo.kind === 'network' ? echo.bodyKey : undefined).toBeTruthy();
    expect((await storage.get((echo as { bodyKey: string }).bodyKey)).toString('utf8')).toContain('•••');
    const needle = Buffer.from(PASSWORD);
    const stored = await filesUnder(storageDir);
    expect(stored.length).toBeGreaterThan(4);
    for (const f of stored) {
      const bytes = await readFile(f);
      expect(bytes.includes(needle), `secret found in ${f}`).toBe(false);
      if (f.endsWith('trace.zip')) {
        for (const [name, data] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
          expect(Buffer.from(data).includes(needle), `secret found in ${f}!${name}`).toBe(false);
        }
      }
    }
    await context.close();
  });
});

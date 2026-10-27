import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { ReplayTimeline } from '@gremlin/contract';
import { FsStorage } from '@gremlin/storage';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { createAgentContext } from '../src/context.js';
import { startRecording } from '../src/recorder/index.js';
import { buildTimeline } from '../src/recorder/timeline.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let work: string;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  work = await mkdtemp(join(tmpdir(), 'gremlin-rec-spa-'));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

async function record(id: string) {
  const storage = new FsStorage(join(work, id, 'storage'));
  const tmpDir = join(work, id, 'tmp');
  const t0 = Date.now();
  const { context, page } = await createAgentContext(browser, { recordVideo: { dir: tmpDir, size: { width: 1280, height: 800 } } });
  const rec = await startRecording(context, { runId: id, t0, storage, keyPrefix: `scans/s/runs/${id}`, tmpDir, secrets: {}, origin: server.url });
  const finish = async () => {
    const stopped = await rec.stop();
    await context.close();
    return ReplayTimeline.parse(JSON.parse((await storage.get(stopped.timelineKey)).toString('utf8')));
  };
  return { page, rec, finish };
}

describe('recorder across navigations', () => {
  it('pushState navigation stays in one segment and emits a navigation signal', async () => {
    const { page, finish } = await record('spa');
    await page.goto(`${server.url}/spa.html`);
    await page.click('#go-products');
    await page.waitForFunction("location.pathname === '/spa/products'");
    await page.click('#go-home');
    await page.waitForFunction("location.pathname === '/spa/home'");
    const tl = await finish();
    expect(tl.rrwebSegments).toHaveLength(1);
    const navs = tl.signals.filter((s) => s.kind === 'navigation').map((s) => (s.kind === 'navigation' ? s.url : ''));
    expect(navs.some((u) => u.endsWith('/spa/products'))).toBe(true);
  });

  it('a full navigation starts a new segment with a later startMs', async () => {
    const { page, finish } = await record('full');
    await page.goto(`${server.url}/spa.html`);
    await page.click('#go-products');
    await page.waitForFunction("location.pathname === '/spa/products'");
    await page.goto(`${server.url}/actions.html`);
    await page.click('text=Increment');
    const tl = await finish();
    expect(tl.rrwebSegments).toHaveLength(2);
    expect(tl.rrwebSegments.map((s) => s.index)).toEqual([0, 1]);
    expect(tl.rrwebSegments[1]!.startMs).toBeGreaterThan(tl.rrwebSegments[0]!.startMs);
    expect(tl.rrwebSegments[1]!.url).toContain('/actions.html');
  });
});

describe('buildTimeline', () => {
  it('sorts signals and findings by tMs and steps by n', () => {
    const tl = buildTimeline({
      runId: 'r',
      t0: 1,
      durationMs: 10,
      rrwebSegments: [],
      steps: [],
      signals: [
        { kind: 'navigation', url: 'http://a/b', tMs: 30 },
        { kind: 'policy', method: 'POST', url: 'http://a/c', tMs: 10 },
        { kind: 'navigation', url: 'http://a/d', tMs: 20 },
      ],
      findings: [
        { id: 'b', tMs: 9 },
        { id: 'a', tMs: 3 },
      ],
    });
    expect(tl.signals.map((s) => s.tMs)).toEqual([10, 20, 30]);
    expect(tl.findings.map((f) => f.id)).toEqual(['a', 'b']);
    ReplayTimeline.parse(tl);
  });
});

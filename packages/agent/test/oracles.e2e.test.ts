import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import type { Signal, Step } from '@gremlin/contract';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
import { runOracles } from '../src/oracles/index.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const step: Step = {
  n: 1,
  action: { type: 'wait', ms: 0, intent: 'load' },
  locator: null,
  intent: 'load',
  tMs: 0,
  stateHash: 'h',
  signals: [],
  outcome: 'ok',
};

/** Wire real page events into Signals the way the recorder will. */
function collect(page: Page, t0: number): Signal[] {
  const signals: Signal[] = [];
  const started = new Map<unknown, number>();
  page.on('pageerror', (e) => signals.push({ kind: 'pageerror', message: e.message, stack: e.stack, tMs: Date.now() - t0 }));
  page.on('console', (m) => {
    if (m.type() === 'error') signals.push({ kind: 'console', level: 'error', text: m.text(), location: m.location().url, tMs: Date.now() - t0 });
  });
  page.on('request', (r) => started.set(r, Date.now()));
  page.on('response', (r) => {
    const req = r.request();
    signals.push({
      kind: 'network',
      method: req.method(),
      url: req.url(),
      status: r.status(),
      durationMs: Date.now() - (started.get(req) ?? Date.now()),
      resourceType: req.resourceType(),
      tMs: Date.now() - t0,
    });
  });
  page.on('requestfailed', (req) =>
    signals.push({
      kind: 'network',
      method: req.method(),
      url: req.url(),
      status: null,
      failure: req.failure()?.errorText,
      durationMs: Date.now() - (started.get(req) ?? Date.now()),
      resourceType: req.resourceType(),
      tMs: Date.now() - t0,
    }),
  );
  return signals;
}

async function run(path: string, opts: { waitMs?: number; route?: (page: Page) => Promise<void> } = {}): Promise<string[]> {
  const page = await browser.newPage();
  try {
    const t0 = Date.now();
    const signals = collect(page, t0);
    await opts.route?.(page);
    await page.goto(`${server.url}${path}`);
    await page.waitForTimeout(opts.waitMs ?? 600);
    const observation = await observe(page);
    const cands = runOracles({ step, signals, observation, origin: server.url, loggedIn: true, settleCappedCount: 0 });
    return cands.map((c) => c.oracle);
  } finally {
    await page.close();
  }
}

describe('oracles e2e: one fixture page per oracle', () => {
  it('clean.html fires nothing', async () => {
    expect(await run('/clean.html')).toEqual([]);
  });
  it('crash', async () => {
    expect(await run('/oracle-crash.html')).toEqual(['crash']);
  });
  it('console', async () => {
    expect(await run('/oracle-console.html')).toEqual(['console']);
  });
  it('network (500 fetch)', async () => {
    expect(await run('/oracle-network.html')).toEqual(['network']);
  });
  it('http (document 404)', async () => {
    const fired = await run('/oracle-http.html', {
      route: async (page) => {
        await page.route('**/oracle-http.html', (r) =>
          r.fulfill({
            status: 404,
            contentType: 'text/html',
            body: '<!doctype html><title>Gone</title><main><h1>Gone</h1><p>The requested document was not found here.</p><button>Home</button></main>',
          }),
        );
      },
    });
    expect(fired).toEqual(['http']);
  });
  it('error_text', async () => {
    expect(await run('/oracle-error-text.html')).toEqual(['error_text']);
  });
  it('blank', async () => {
    expect(await run('/oracle-blank.html')).toEqual(['blank']);
  });
  it('slow (request > 5s)', async () => {
    expect(await run('/oracle-slow.html', { waitMs: 6600 })).toEqual(['slow']);
  }, 30_000);
});

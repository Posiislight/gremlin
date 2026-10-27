import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { settle } from '../src/settle.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let page: Page;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('settle', () => {
  it('returns after the quiet period on a quiet page', async () => {
    await page.goto(`${server.url}/empty.html`);
    const r = await settle(page, { quietMs: 200, capMs: 30_000 });
    expect(r.capped).toBe(false); // returned on quiet, long before the cap
    expect(r.ms).toBeGreaterThanOrEqual(190);
  });

  it('is idempotent and extends while the DOM mutates', async () => {
    await page.goto(`${server.url}/empty.html`);
    await settle(page, { quietMs: 100 });
    await settle(page, { quietMs: 100 });
    await page.evaluate(
      `(() => { let n = 0; window.mutDone = false; const t = setInterval(() => { document.body.append(String(n++)); if (n > 8) { clearInterval(t); window.mutDone = true; } }, 80); })()`,
    );
    // quietMs far above the 80 ms mutation interval, so a stalled timer on a loaded machine is not "quiet".
    const r = await settle(page, { quietMs: 1500, capMs: 60_000 });
    expect(r.capped).toBe(false);
    expect(await page.evaluate('window.mutDone')).toBe(true); // it waited for the mutations to end
    expect(r.ms).toBeGreaterThanOrEqual(1500 + 8 * 80 - 50);
  });

  it('caps while a request is in flight', async () => {
    await page.goto(`${server.url}/empty.html`);
    const seen = page.waitForRequest('**/api/slow'); // the request is in flight before settle starts
    await page.evaluate(() => void fetch('/api/slow').catch(() => null));
    await seen;
    const r = await settle(page, { quietMs: 100, capMs: 600 });
    expect(r.capped).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(590);
  });

  it('survives navigation', async () => {
    await page.goto(`${server.url}/empty.html`);
    await settle(page, { quietMs: 100 });
    await page.goto(`${server.url}/form.html`);
    const r = await settle(page, { quietMs: 100 });
    expect(r.capped).toBe(false);
  });

  it('an SPA route change (pushState) that starts a slow fetch is still waited on', async () => {
    await page.goto(`${server.url}/empty.html`);
    await settle(page, { quietMs: 100 });
    const seen = page.waitForRequest('**/api/slow');
    await page.evaluate(`(() => { history.pushState({}, '', '/spa-next'); fetch('/api/slow').catch(() => null); })()`);
    await seen;
    const r = await settle(page, { quietMs: 100, capMs: 700 });
    expect(r.capped).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(690);
  });

  it('forgets requests of a document that was navigated away from', async () => {
    await page.goto(`${server.url}/empty.html`);
    await settle(page, { quietMs: 100 });
    const seen = page.waitForRequest('**/api/slow');
    await page.evaluate(`fetch('/api/slow').catch(() => null)`);
    await seen; // seen before the navigation that must make settle forget it
    await page.goto(`${server.url}/form.html`);
    const r = await settle(page, { quietMs: 100, capMs: 1500 });
    expect(r.capped).toBe(false);
  });
});

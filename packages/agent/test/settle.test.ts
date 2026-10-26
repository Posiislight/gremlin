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
    const r = await settle(page, { quietMs: 200 });
    expect(r.capped).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(190);
    expect(r.ms).toBeLessThan(1500);
  });

  it('is idempotent and extends while the DOM mutates', async () => {
    await page.goto(`${server.url}/empty.html`);
    await settle(page, { quietMs: 100 });
    await settle(page, { quietMs: 100 });
    await page.evaluate(
      `(() => { let n = 0; const t = setInterval(() => { document.body.append(String(n++)); if (n > 8) clearInterval(t); }, 80); })()`,
    );
    const r = await settle(page, { quietMs: 400 }); // generous: timers can stall under parallel test load
    expect(r.capped).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(900);
  });

  it('caps while a request is in flight', async () => {
    await page.goto(`${server.url}/empty.html`);
    await page.evaluate(() => void fetch('/api/slow').catch(() => null));
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
    await page.evaluate(`(() => { history.pushState({}, '', '/spa-next'); fetch('/api/slow').catch(() => null); })()`);
    const r = await settle(page, { quietMs: 100, capMs: 700 });
    expect(r.capped).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(690);
  });

  it('forgets requests of a document that was navigated away from', async () => {
    await page.goto(`${server.url}/empty.html`);
    await settle(page, { quietMs: 100 });
    await page.evaluate(`fetch('/api/slow').catch(() => null)`);
    await page.goto(`${server.url}/form.html`);
    const r = await settle(page, { quietMs: 100, capMs: 1500 });
    expect(r.capped).toBe(false);
  });
});

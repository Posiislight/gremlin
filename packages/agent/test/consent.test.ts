import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { dismissConsent } from '../src/consent.js';

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

describe('dismissConsent', () => {
  it('clicks Reject, never Accept', async () => {
    await page.goto(`${server.url}/consent.html`);
    expect(await dismissConsent(page)).toBe(true);
    expect(await page.evaluate('window.__clicked')).toBe('reject');
    expect(await page.locator('#cookie-banner').count()).toBe(0);
  });

  it('returns false quickly when there is no banner', async () => {
    await page.goto(`${server.url}/form.html`);
    const t0 = Date.now();
    expect(await dismissConsent(page)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('does not click accept when only an accept button exists', async () => {
    await page.setContent(
      `<div id="cookie-x"><button onclick="window.__c=1">Accept all</button></div>`,
    );
    expect(await dismissConsent(page)).toBe(false);
    expect(await page.evaluate('window.__c')).toBeUndefined();
  });
});

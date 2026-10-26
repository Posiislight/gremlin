import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { execute } from '../src/execute.js';

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

describe('execute with a missing ref', () => {
  it('returns an error outcome without throwing or changing the page', async () => {
    await page.goto(`${server.url}/actions.html`);
    const before = await page.content();
    const ctx = { secrets: {}, origin: server.url, fixturesDir: '.' };
    for (const a of [
      { type: 'click', ref: 'e999', intent: 'i' },
      { type: 'type', ref: 'e999', text: 'x', intent: 'i' },
      { type: 'select', ref: 'e999', option: 'x', intent: 'i' },
      { type: 'hover', ref: 'e999', intent: 'i' },
      { type: 'upload', ref: 'e999', fixture: 'form.html', intent: 'i' },
    ] as const) {
      const r = await execute(page, a, ctx);
      expect(r.outcome).toBe('error');
      expect(r.error).toMatch(/ref e999 not found/);
      expect(r.locator).toBeNull();
    }
    expect(await page.content()).toBe(before);
  });
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';

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

it('huge page stays within the budget with exactly 150 interactables', async () => {
  const page = await browser.newPage();
  await page.goto(`${server.url}/huge.html`);
  const o = await observe(page);
  expect(o.interactables.length).toBe(150);
  expect(o.tokenEstimate).toBeLessThanOrEqual(6000);
  expect(o.rendered.length / 4).toBeLessThanOrEqual(6000);
});

it('honours custom maxInteractables', async () => {
  const page = await browser.newPage();
  await page.goto(`${server.url}/huge.html`);
  const o = await observe(page, { maxInteractables: 20 });
  expect(o.interactables.length).toBe(20);
});

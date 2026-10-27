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

it('pushState route change changes path and stateHash', async () => {
  const page = await browser.newPage();
  await page.goto(`${server.url}/spa.html`);
  const before = await observe(page);
  expect(before.path).toBe('/spa/home');
  await page.click('#go-products');
  const after = await observe(page, { previous: before });
  expect(after.path).toBe('/spa/products');
  expect(after.stateHash).not.toBe(before.stateHash);
  expect(after.interactables.some((i) => i.name === 'Add to cart')).toBe(true);
  expect(after.rendered).not.toContain('(unchanged');
});

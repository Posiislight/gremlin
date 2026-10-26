import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
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

async function refOf(name: string): Promise<string> {
  const o = await observe(page);
  return o.interactables.find((x) => x.name === name)!.ref;
}

describe('popups', () => {
  it('same-origin target=_blank: popup closed and agent page navigates', async () => {
    await page.goto(`${server.url}/popup.html`);
    const ctx = { secrets: {}, origin: server.url, fixturesDir: '.' };
    const r = await execute(page, { type: 'click', ref: await refOf('Open same-origin'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(page.url()).toBe(`${server.url}/empty.html`);
    expect(page.context().pages()).toHaveLength(1);
  });

  it('off-origin window.open: popup closed, page unchanged', async () => {
    await page.goto(`${server.url}/popup.html`);
    const ctx = { secrets: {}, origin: server.url, fixturesDir: '.' };
    const r = await execute(page, { type: 'click', ref: await refOf('Open off-origin'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(page.url()).toBe(`${server.url}/popup.html`);
    expect(page.context().pages()).toHaveLength(1);
  });
});

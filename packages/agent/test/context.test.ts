import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { createAgentContext } from '../src/context.js';

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

// With serviceWorkers:'block' register() resolves to undefined (no registration object); otherwise a registration.
const REGISTER = `Promise.resolve().then(() => navigator.serviceWorker.register('/sw.js')).then((r) => (r ? 'registered' : 'blocked'), () => 'blocked')`;

describe('createAgentContext', () => {
  it('blocks service workers (with a control that proves registration works otherwise)', async () => {
    const control = await browser.newContext();
    const cp = await control.newPage();
    await cp.goto(`${server.url}/empty.html`);
    expect(await cp.evaluate(REGISTER)).toBe('registered');
    await expect.poll(() => control.serviceWorkers().length).toBe(1);
    await control.close();

    const { context, page } = await createAgentContext(browser);
    await page.goto(`${server.url}/empty.html`);
    expect(await page.evaluate(REGISTER)).toBe('blocked');
    await page.waitForTimeout(500);
    expect(context.serviceWorkers()).toHaveLength(0);
    await context.close();
  });
});

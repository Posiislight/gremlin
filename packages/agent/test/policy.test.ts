import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { installPolicy } from '../src/policy.js';

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

async function setup(mode: 'read_only' | 'full', authAllowlist: string[] = []) {
  const context: BrowserContext = await browser.newContext();
  const { blocked } = await installPolicy(context, { origin: server.url, allowedActions: mode, authAllowlist });
  const page: Page = await context.newPage();
  await page.goto(`${server.url}/empty.html`);
  return { context, page, blocked };
}

const post = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    try {
      const r = await fetch(p, { method: 'POST', body: 'x' });
      return r.status;
    } catch {
      return 'blocked';
    }
  }, path);

describe('installPolicy', () => {
  it('read_only aborts POST to the target origin and logs a policy signal; GET is allowed', async () => {
    const { context, page, blocked } = await setup('read_only');
    expect(await post(page, '/api/echo')).toBe('blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ kind: 'policy', method: 'POST', url: `${server.url}/api/echo` });
    expect(typeof (blocked[0] as { tMs: number }).tMs).toBe('number');
    expect(await page.evaluate(async () => (await fetch('/api/ok')).status)).toBe(200);
    await context.close();
  });

  it('read_only lets allowlisted auth paths through', async () => {
    const { context, page, blocked } = await setup('read_only', ['/api/echo']);
    expect(await post(page, '/api/echo')).toBe(200);
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('read_only allows non-GET to third-party origins (only the target origin is constrained)', async () => {
    const { context, page, blocked } = await setup('read_only');
    // An unroutable third-party POST must reach the network layer (fail there), not be policy-blocked.
    await page.evaluate(() => fetch('http://127.0.0.1:1/x', { method: 'POST', body: 'x' }).catch(() => null));
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('full allows POST to the target origin', async () => {
    const { context, page, blocked } = await setup('full');
    expect(await post(page, '/api/echo')).toBe(200);
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('aborts navigation off-origin in both modes', async () => {
    for (const mode of ['read_only', 'full'] as const) {
      const { context, page } = await setup(mode);
      await expect(page.goto('https://example.org/')).rejects.toThrow();
      await context.close();
    }
  });

  it('allows navigation to extraHosts', async () => {
    const context = await browser.newContext();
    await installPolicy(context, {
      origin: 'http://elsewhere.invalid',
      allowedActions: 'full',
      authAllowlist: [],
      extraHosts: ['127.0.0.1'],
    });
    const page = await context.newPage();
    const res = await page.goto(`${server.url}/empty.html`);
    expect(res?.status()).toBe(200);
    await context.close();
  });

  it('always aborts payment hosts', async () => {
    const { context, page } = await setup('full');
    for (const host of ['checkout.stripe.com', 'js.stripe.com', 'www.paypal.com', 'paypal.com', 'adyen.com', 'squareup.com']) {
      const r = await page.evaluate(async (h) => {
        try {
          await fetch(`https://${h}/x`, { mode: 'no-cors' });
          return 'ok';
        } catch {
          return 'blocked';
        }
      }, host);
      expect(r, host).toBe('blocked');
    }
    await context.close();
  });
});

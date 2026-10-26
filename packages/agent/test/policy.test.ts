import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { installPolicy, type PolicyHandle, type PolicyOptions } from '../src/policy.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>; // the target, 127.0.0.1
let other: Awaited<ReturnType<typeof startFixtureServer>>; // a genuinely foreign site: 127.0.0.2
let sibling: Awaited<ReturnType<typeof startFixtureServer>>; // another port on the target host

beforeAll(async () => {
  server = await startFixtureServer();
  other = await startFixtureServer('127.0.0.2');
  sibling = await startFixtureServer();
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  await other?.close();
  await sibling?.close();
});

async function setup(mode: 'read_only' | 'full', extra: Partial<PolicyOptions> = {}) {
  const context: BrowserContext = await browser.newContext({ serviceWorkers: 'block' });
  const policy: PolicyHandle = await installPolicy(context, {
    origin: server.url,
    allowedActions: mode,
    authAllowlist: [],
    ...extra,
  });
  const page: Page = await context.newPage();
  await page.goto(`${server.url}/empty.html`);
  return { context, page, blocked: policy.blocked, policy };
}

const status = (page: Page, url: string, init = '{}') =>
  page.evaluate(`fetch(${JSON.stringify(url)}, ${init}).then(r => r.status, () => 'blocked')`) as Promise<number | 'blocked'>;
const post = (page: Page, url: string) => status(page, url, `{ method: 'POST', body: 'x', mode: 'no-cors' }`);
const hitsOf = async (base: string) => ((await (await fetch(`${base}/api/hits`)).json()) as { hits: number }).hits;
const urls = (blocked: PolicyHandle['blocked']) => blocked.map((b) => (b.kind === 'policy' ? `${b.method} ${b.url}` : ''));

describe('read_only writes', () => {
  it('aborts a fetch POST to the target, records a signal, and the server never sees it', async () => {
    const { context, page, blocked } = await setup('read_only');
    const before = await hitsOf(server.url);
    expect(await post(page, `${server.url}/api/hit`)).toBe('blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ kind: 'policy', method: 'POST', url: `${server.url}/api/hit` });
    expect(typeof (blocked[0] as { tMs: number }).tMs).toBe('number');
    expect(await hitsOf(server.url)).toBe(before);
    expect(await status(page, `${server.url}/api/ok`)).toBe(200);
    expect(blocked).toHaveLength(1);
    await context.close();
  });

  it('aborts a form POST navigation', async () => {
    const { context, page, blocked } = await setup('read_only');
    const before = await hitsOf(server.url);
    await page.evaluate(
      `(() => { document.body.insertAdjacentHTML('beforeend', '<form id="pf" method="post" action="/api/hit"><input name="a" value="1"></form>'); document.getElementById('pf').submit(); })()`,
    );
    await expect.poll(() => blocked.length).toBe(1);
    expect(urls(blocked)).toEqual([`POST ${server.url}/api/hit`]);
    expect(await hitsOf(server.url)).toBe(before);
    await context.close();
  });

  it('aborts navigator.sendBeacon', async () => {
    const { context, page, blocked } = await setup('read_only');
    const before = await hitsOf(server.url);
    await page.evaluate(`navigator.sendBeacon('/api/hit', 'x')`);
    await expect.poll(() => blocked.length).toBe(1);
    expect(urls(blocked)).toEqual([`POST ${server.url}/api/hit`]);
    expect(await hitsOf(server.url)).toBe(before);
    await context.close();
  });

  it('auth allowlist matches on path-segment boundaries', async () => {
    const { context, page, blocked } = await setup('read_only', { authAllowlist: ['/api/login'] });
    expect(await post(page, `${server.url}/api/login`)).not.toBe('blocked');
    expect(await post(page, `${server.url}/api/login/step2`)).not.toBe('blocked');
    expect(blocked).toHaveLength(0);
    expect(await post(page, `${server.url}/api/loginx`)).toBe('blocked');
    expect(await post(page, `${server.url}/api/login-history/delete`)).toBe('blocked');
    expect(urls(blocked)).toEqual([`POST ${server.url}/api/loginx`, `POST ${server.url}/api/login-history/delete`]);
    await context.close();
  });

  it('rejects empty or root allowlist entries at install time', async () => {
    const context = await browser.newContext();
    for (const bad of ['', '/', 'api/login']) {
      await expect(installPolicy(context, { origin: server.url, allowedActions: 'read_only', authAllowlist: [bad] })).rejects.toThrow(/authAllowlist/);
    }
    await context.close();
  });

  it('blocks the whole site: loopback aliases, other ports, apiHosts; allows genuine third parties', async () => {
    const { context, page, blocked } = await setup('read_only');
    const alias = `http://localhost:${new URL(server.url).port}`;
    expect(await post(page, `${alias}/api/hit`)).toBe('blocked');
    expect(await post(page, `${sibling.url}/api/hit`)).toBe('blocked');
    expect(await hitsOf(sibling.url)).toBe(0);
    expect(blocked).toHaveLength(2);
    // Third party (127.0.0.2 is a different host, not a loopback alias): allowed, and the server sees it.
    expect(await post(page, `${other.url}/api/hit`)).not.toBe('blocked');
    expect(await hitsOf(other.url)).toBe(1);
    expect(blocked).toHaveLength(2);
    await context.close();

    const api = await setup('read_only', { apiHosts: ['127.0.0.2'] });
    expect(await post(api.page, `${other.url}/api/hit`)).toBe('blocked');
    expect(api.blocked).toHaveLength(1);
    await api.context.close();
  });

  it('treats subdomains of the target registrable domain as the same site', async () => {
    const context = await browser.newContext();
    const { blocked } = await installPolicy(context, { origin: 'http://app.example.test', allowedActions: 'read_only', authAllowlist: [] });
    const page = await context.newPage();
    expect(await post(page, 'http://api.example.test/x')).toBe('blocked');
    expect(urls(blocked)).toEqual(['POST http://api.example.test/x']);
    await post(page, 'http://thirdparty.other-test/x'); // different site: not policy-blocked (fails at DNS)
    expect(blocked).toHaveLength(1);
    await context.close();
  });
});

describe('full mode', () => {
  it('allows POST to the target', async () => {
    const { context, page, blocked } = await setup('full');
    const before = await hitsOf(server.url);
    expect(await post(page, `${server.url}/api/hit`)).not.toBe('blocked');
    expect(await hitsOf(server.url)).toBe(before + 1);
    expect(blocked).toHaveLength(0);
    await context.close();
  });
});

describe('navigation and payment hosts', () => {
  it('aborts a navigation to another site in both modes and records it', async () => {
    for (const mode of ['read_only', 'full'] as const) {
      const { context, page, blocked } = await setup(mode);
      await expect(page.goto(`${other.url}/empty.html`)).rejects.toThrow();
      expect(urls(blocked)).toEqual([`GET ${other.url}/empty.html`]);
      expect(page.url()).toBe(`${server.url}/empty.html`);
      await context.close();
    }
  });

  it('allows navigation to extraHosts', async () => {
    const { context, page, blocked } = await setup('full', { extraHosts: ['127.0.0.2'] });
    const res = await page.goto(`${other.url}/empty.html`);
    expect(res?.status()).toBe(200);
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('always aborts payment hosts (incl. subdomains and a trailing dot) and records each', async () => {
    for (const mode of ['full', 'read_only'] as const) {
      const { context, page, blocked } = await setup(mode);
      const hosts = ['checkout.stripe.com', 'js.stripe.com', 'www.paypal.com', 'paypal.com', 'adyen.com', 'squareup.com', 'stripe.com.', 'CHECKOUT.Stripe.com'];
      for (const h of hosts) {
        expect(await status(page, `https://${h}/x`, `{ mode: 'no-cors' }`), h).toBe('blocked');
      }
      expect(blocked).toHaveLength(hosts.length);
      await context.close();
    }
  });
});

describe('redirects', () => {
  it.each([302, 303, 307])('a %i from the target to a foreign document is blocked and never loaded', async (code) => {
    const { context, page, blocked } = await setup('read_only');
    await expect(page.goto(`${server.url}/redirect?to=${encodeURIComponent(other.url + '/form.html')}&status=${code}`)).rejects.toThrow();
    expect(urls(blocked)).toEqual([`GET ${other.url}/form.html`]);
    expect(page.url()).toBe(`${server.url}/empty.html`);
    expect(await page.title()).not.toBe('Form fixture');
    await context.close();
  });

  it('a redirect to a payment page is blocked and never loaded', async () => {
    const { context, page, blocked } = await setup('full');
    await expect(page.goto(`${server.url}/redirect?to=${encodeURIComponent('https://checkout.stripe.com/x')}`)).rejects.toThrow();
    expect(urls(blocked)).toEqual(['GET https://checkout.stripe.com/x']);
    expect(page.url()).toBe(`${server.url}/empty.html`);
    await context.close();
  });

  it('a same-site redirect still loads the final document', async () => {
    const { context, page, blocked } = await setup('read_only');
    const res = await page.goto(`${server.url}/redirect?to=${encodeURIComponent('/form.html')}&status=302`);
    expect(res?.status()).toBe(200);
    expect(await page.title()).toBe('Form fixture');
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('a third-party POST that 307s to the target is blocked at the hop', async () => {
    const { context, page, blocked } = await setup('read_only');
    const before = await hitsOf(server.url);
    const to = encodeURIComponent(`${server.url}/api/hit`);
    await post(page, `${other.url}/redirect?to=${to}&status=307`);
    expect(urls(blocked)).toEqual([`POST ${server.url}/api/hit`]);
    expect(await hitsOf(server.url)).toBe(before);
    await context.close();
  });

  it('subresource GET redirects to a payment host are recorded by the backstop and the page is blanked', async () => {
    const { context, page, blocked } = await setup('full');
    await page.evaluate(`fetch('/redirect?to=${encodeURIComponent('https://checkout.stripe.com/x')}', { mode: 'no-cors' }).catch(() => null)`).catch(() => null);
    await expect.poll(() => blocked.length).toBe(1);
    expect(urls(blocked)).toEqual(['GET https://checkout.stripe.com/x']);
    await expect.poll(() => page.url()).toBe('about:blank');
    await context.close();
  });
});

describe('websockets', () => {
  const wsResult = (page: Page, url: string) =>
    page.evaluate(
      `new Promise((res) => { const w = new WebSocket(${JSON.stringify(url)}); w.onclose = () => res('closed'); w.onerror = () => {}; setTimeout(() => res('timeout'), 4000); })`,
    );

  it('read_only blocks sockets to the target site and records them', async () => {
    const { context, page, blocked } = await setup('read_only');
    expect(await wsResult(page, `${server.url.replace('http', 'ws')}/ws`)).toBe('closed');
    expect(urls(blocked)).toEqual([`WS ${server.url.replace('http', 'ws')}/ws`]);
    await context.close();
  });

  it('payment sockets are blocked in full mode too; ordinary target sockets are not policy-blocked', async () => {
    const { context, page, blocked } = await setup('full');
    expect(await wsResult(page, 'wss://checkout.stripe.com/ws')).toBe('closed');
    expect(urls(blocked)).toEqual(['WS wss://checkout.stripe.com/ws']);
    await wsResult(page, `${server.url.replace('http', 'ws')}/ws`);
    expect(blocked).toHaveLength(1);
    await context.close();
  });
});

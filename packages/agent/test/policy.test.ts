import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { asHost, FOREIGN } from './hosts.js';
import { startFixtureServer, STREAM_MS } from './server.js';
import { installPolicy, markServiceWorkersBlocked, type PolicyHandle, type PolicyOptions } from '../src/policy.js';

type Srv = Awaited<ReturnType<typeof startFixtureServer>>;

let browser: Browser;
let server: Srv; // the target, 127.0.0.1
let sibling: Srv; // another port on the target host
let foreignSrv: Srv; // reached as http://foreign.test:<port>: a genuinely foreign site
let paySrv: Srv; // reached as http://checkout.stripe.com:<port>
let foreign: string;
let pay: string;

beforeAll(async () => {
  server = await startFixtureServer();
  sibling = await startFixtureServer();
  foreignSrv = await startFixtureServer();
  paySrv = await startFixtureServer();
  foreign = asHost(foreignSrv.url, FOREIGN);
  pay = asHost(paySrv.url, 'checkout.stripe.com');
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  for (const s of [server, sibling, foreignSrv, paySrv]) await s?.close();
});

async function setup(mode: 'read_only' | 'full', extra: Partial<PolicyOptions> = {}) {
  const context: BrowserContext = await browser.newContext({ serviceWorkers: 'block' });
  markServiceWorkersBlocked(context);
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
const json = async (base: string, path: string) => (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>;
const hitsOf = async (base: string) => (await json(base, '/api/hits')).hits as number;
const totalOf = async (base: string) => (await json(base, '/api/total')).total as number;
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
    const context = await browser.newContext({ serviceWorkers: 'block' });
    for (const bad of ['', '/', 'api/login']) {
      await expect(installPolicy(context, { origin: server.url, allowedActions: 'read_only', authAllowlist: [bad] })).rejects.toThrow(/authAllowlist/);
    }
    await context.close();
  });

  it('blocks the whole site (loopback aliases, other ports, apiHosts) but lets genuine third parties through', async () => {
    const { context, page, blocked } = await setup('read_only');
    expect(await post(page, `http://localhost:${new URL(server.url).port}/api/hit`)).toBe('blocked');
    expect(await post(page, `${sibling.url}/api/hit`)).toBe('blocked');
    expect(await hitsOf(sibling.url)).toBe(0);
    expect(blocked).toHaveLength(2);
    expect(await post(page, `${foreign}/api/hit`)).not.toBe('blocked');
    expect(await hitsOf(foreignSrv.url)).toBe(1);
    expect(blocked).toHaveLength(2);
    await context.close();

    const api = await setup('read_only', { apiHosts: [FOREIGN] });
    expect(await post(api.page, `${foreign}/api/hit`)).toBe('blocked');
    expect(api.blocked).toHaveLength(1);
    expect(await hitsOf(foreignSrv.url)).toBe(1); // unchanged
    await api.context.close();
  });

  it('treats subdomains of the target registrable domain as the same site', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    markServiceWorkersBlocked(context);
    const { blocked } = await installPolicy(context, { origin: 'http://app.example.test', allowedActions: 'read_only', authAllowlist: [] });
    const page = await context.newPage();
    expect(await post(page, 'http://api.example.test/x')).toBe('blocked');
    expect(urls(blocked)).toEqual(['POST http://api.example.test/x']);
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
  it('aborts a navigation to another site in both modes and the foreign server gets no hit', async () => {
    for (const mode of ['read_only', 'full'] as const) {
      const before = await totalOf(foreignSrv.url);
      const { context, page, blocked } = await setup(mode);
      await expect(page.goto(`${foreign}/empty.html`)).rejects.toThrow();
      expect(urls(blocked)).toEqual([`GET ${foreign}/empty.html`]);
      expect(page.url()).toBe(`${server.url}/empty.html`);
      expect(await totalOf(foreignSrv.url)).toBe(before);
      await context.close();
    }
  });

  it('allows navigation to extraHosts', async () => {
    const { context, page, blocked } = await setup('full', { extraHosts: [FOREIGN] });
    const res = await page.goto(`${foreign}/empty.html`);
    expect(res?.status()).toBe(200);
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('always aborts payment hosts (subdomains, case, trailing dot) and the payment server gets no hit', async () => {
    for (const mode of ['full', 'read_only'] as const) {
      const before = paySrv.connections();
      const { context, page, blocked } = await setup(mode);
      const hosts = ['checkout.stripe.com', 'js.stripe.com', 'www.paypal.com', 'paypal.com', 'adyen.com', 'squareup.com', 'stripe.com', 'CHECKOUT.Stripe.com'];
      for (const h of hosts) {
        expect(await status(page, asHost(paySrv.url, h) + '/x', `{ mode: 'no-cors' }`), h).toBe('blocked');
      }
      expect(await status(page, `http://stripe.com.:${new URL(paySrv.url).port}/x`, `{ mode: 'no-cors' }`)).toBe('blocked');
      expect(blocked).toHaveLength(hosts.length + 1);
      expect(paySrv.connections()).toBe(before);
      await context.close();
    }
  });
});

describe('native redirects (CDP interception pauses every hop)', () => {
  it('(a) login -> 302 + Set-Cookie -> /app/ keeps the real URL, base, relative links, fetch, form and cookie', async () => {
    for (const mode of ['full', 'read_only'] as const) {
      const { context, page, blocked } = await setup(mode);
      await page.goto(`${server.url}/login`);
      await page.waitForFunction('window.fetched !== undefined');
      expect(page.url()).toBe(`${server.url}/app/`);
      expect(await page.evaluate('[location.href, document.baseURI]')).toEqual([`${server.url}/app/`, `${server.url}/app/`]);
      expect(await page.evaluate(`document.getElementById('rel').href`)).toBe(`${server.url}/app/next`);
      expect(await page.evaluate(`document.getElementById('f').action`)).toBe(`${server.url}/app/save`);
      expect(await page.evaluate('window.fetched')).toBe('APPDATA');
      expect(await page.evaluate('document.cookie')).toContain('sess=fromhop');
      expect(blocked).toHaveLength(0);
      await context.close();
    }
  });

  it('(b) the target API on another loopback port and the localhost alias work from the page', async () => {
    for (const mode of ['full', 'read_only'] as const) {
      const { context, page, blocked } = await setup(mode);
      expect(await status(page, `${sibling.url}/api/ok`)).toBe(200);
      expect(await status(page, `http://localhost:${new URL(server.url).port}/api/ok`)).toBe(200);
      expect(await status(page, `http://localhost:${new URL(sibling.url).port}/api/ok`)).toBe(200);
      expect(blocked).toHaveLength(0);
      await context.close();
    }
  });

  it('(c) a streamed page shows its first content while the response is still open', async () => {
    const { context, page } = await setup('read_only');
    // The server holds the tail until released (no timing assumption): seeing the first chunk while the
    // response is still open proves nothing is buffered until the end.
    await page.goto(`${server.url}/stream`, { waitUntil: 'commit' });
    await page.waitForSelector('#early', { timeout: STREAM_MS / 2 });
    expect(await page.locator('#late').count()).toBe(0);
    expect(await json(server.url, '/stream-release')).toEqual({ released: 1 });
    await page.waitForSelector('#late');
    await context.close();
  });

  it.each([302, 303, 307])('(d) a %i open redirect to a foreign document is blocked, not loaded, never requested', async (code) => {
    const before = await totalOf(foreignSrv.url);
    const { context, page, blocked } = await setup('read_only');
    await expect(page.goto(`${server.url}/redirect?to=${encodeURIComponent(foreign + '/form.html')}&status=${code}`)).rejects.toThrow();
    expect(urls(blocked)).toEqual([`GET ${foreign}/form.html`]);
    expect(page.url()).toBe(`${server.url}/empty.html`);
    expect(await totalOf(foreignSrv.url)).toBe(before);
    await context.close();
  });

  it('(e) a redirect to a payment page is blocked at the hop; the payment server gets no hit', async () => {
    const before = paySrv.connections();
    const { context, page, blocked, policy } = await setup('full');
    await expect(page.goto(`${server.url}/redirect?to=${encodeURIComponent(pay + '/x?token=secret')}`)).rejects.toThrow();
    expect(urls(blocked)).toEqual([`GET ${pay}/x`]); // query stripped for hops
    expect(policy.details[0]).toMatchObject({ resourceType: 'Document', isRedirect: true, hadQuery: true });
    expect(policy.details[0]?.frameId).toBeTruthy();
    expect(policy.details[0]?.reason).toContain('payment host');
    expect(page.url()).toBe(`${server.url}/empty.html`);
    expect(paySrv.connections()).toBe(before);
    await context.close();
  });

  it('(f) a third-party POST that 307s to the target is blocked at the hop; the target never sees it', async () => {
    const { context, page, blocked } = await setup('read_only');
    const before = await hitsOf(server.url);
    await post(page, `${foreign}/redirect?to=${encodeURIComponent(server.url + '/api/hit')}&status=307`);
    expect(urls(blocked)).toEqual([`POST ${server.url}/api/hit`]);
    expect(await hitsOf(server.url)).toBe(before);
    await context.close();
  });

  it('(g) image and XHR GET redirects to a payment host are blocked at the hop; benign third parties are not', async () => {
    const before = paySrv.connections();
    const { context, page, blocked } = await setup('read_only');
    const to = encodeURIComponent(pay + '/pic');
    await page.evaluate(`new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => r('done'); i.src = '/redirect?to=${to}'; })`);
    expect(await status(page, `/redirect?to=${to}`, `{ mode: 'no-cors' }`)).toBe('blocked');
    expect(urls(blocked)).toEqual([`GET ${pay}/pic`, `GET ${pay}/pic`]);
    expect(paySrv.connections()).toBe(before);
    // control: a non-payment third-party image redirect is allowed natively and does reach the server
    const f0 = await totalOf(foreignSrv.url);
    await page.evaluate(`new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => r('done'); i.src = '/redirect?to=${encodeURIComponent(foreign + '/pic')}'; })`);
    expect(await totalOf(foreignSrv.url)).toBe(f0 + 1);
    expect(blocked).toHaveLength(2);
    await context.close();
  });

  it('(h) a cross-site iframe image redirect and a dedicated worker POST redirect are blocked at the hop', async () => {
    const payBefore = paySrv.connections();
    const hitsBefore = await hitsOf(server.url);
    const fBefore = await totalOf(foreignSrv.url);
    const { context, page, blocked } = await setup('read_only', { extraHosts: [FOREIGN] });
    await page.evaluate(
      `document.body.insertAdjacentHTML('beforeend', '<iframe src="${foreign}/frame?to=${encodeURIComponent(pay + '/charge')}"></iframe>')`,
    );
    await expect.poll(() => blocked.length).toBe(1);
    expect(urls(blocked)).toEqual([`GET ${pay}/charge`]);
    expect(await totalOf(foreignSrv.url)).toBeGreaterThanOrEqual(fBefore + 2); // the iframe really loaded (frame + redirect hop)
    expect(paySrv.connections()).toBe(payBefore);

    await context.close();
  });

  it('(h2) a dedicated worker POST that 307s to the target is blocked at the hop', async () => {
    const hitsBefore = await hitsOf(server.url);
    const { context, page, blocked } = await setup('read_only');
    const name = `${foreign}/redirect?status=307&to=${encodeURIComponent(server.url + '/api/hit')}`;
    const f1 = await totalOf(foreignSrv.url);
    await page.evaluate(`new Worker('/worker.js', { name: ${JSON.stringify(name)} })`);
    await expect.poll(() => blocked.length).toBe(1);
    expect(urls(blocked)).toEqual([`POST ${server.url}/api/hit`]);
    expect(await totalOf(foreignSrv.url)).toBeGreaterThan(f1); // the worker's POST did reach the third party
    expect(await hitsOf(server.url)).toBe(hitsBefore);
    await context.close();
  });

  it('(i) a redirect loop ends with ERR_TOO_MANY_REDIRECTS and is not a policy block', async () => {
    const { context, page, blocked } = await setup('read_only');
    await expect(page.goto(`${server.url}/loop`)).rejects.toThrow(/ERR_TOO_MANY_REDIRECTS/);
    expect(blocked).toHaveLength(0);
    await context.close();
  });

  it('(j) cookies follow native SameSite rules: same result with and without the policy', async () => {
    const scenario = async (page: Page) => {
      await page.goto(`${server.url}/setcookie`);
      await page.evaluate(`fetch('/api/whoami', { credentials: 'include' }).then(r => r.status)`);
      const sameSite = (await json(server.url, '/api/last-cookie')).cookie;
      await page.evaluate(
        `fetch(${JSON.stringify(foreign + '/redirect?to=' + encodeURIComponent(server.url + '/api/whoami'))}, { credentials: 'include', mode: 'no-cors' }).then(() => 'ok')`,
      );
      const viaForeign = (await json(server.url, '/api/last-cookie')).cookie;
      return { sameSite, viaForeign };
    };
    const plain = await browser.newContext();
    const expected = await scenario(await plain.newPage());
    await plain.close();
    expect(expected.sameSite).toContain('lax=1'); // control: the cookie exists and is sent same-site

    const { context, page, blocked } = await setup('read_only');
    expect(await scenario(page)).toEqual(expected);
    expect(blocked).toHaveLength(0);
    await context.close();
  });
});

describe('every paused request is released', () => {
  it('a burst of 200 concurrent requests leaves nothing paused', async () => {
    const { context, page, policy } = await setup('read_only');
    const statuses = (await page.evaluate(
      `Promise.all(Array.from({ length: 200 }, (_, i) => fetch('/api/ok?i=' + i).then(r => r.status)))`,
    )) as number[];
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(policy.paused()).toBe(0);
    await context.close();
  });

  it('closing a page with requests in flight leaves nothing paused and other pages keep working', async () => {
    const { context, page, policy } = await setup('read_only');
    const doomed = await context.newPage();
    await doomed.goto(`${server.url}/empty.html`);
    await doomed.evaluate(`for (let i = 0; i < 200; i++) fetch('/api/ok?i=' + i).catch(() => null); 0`);
    await doomed.close();
    await expect.poll(() => policy.paused(), { timeout: 5000 }).toBe(0);
    expect(await status(page, `${server.url}/api/ok`)).toBe(200);
    await context.close();
  });
});

describe('websockets', () => {
  const wsResult = (page: Page, url: string) =>
    page.evaluate(
      `new Promise((res) => { const w = new WebSocket(${JSON.stringify(url)}); w.onclose = () => res('closed'); w.onerror = () => {}; setTimeout(() => res('timeout'), 15000); })`,
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

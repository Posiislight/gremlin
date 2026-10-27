import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
import { execute } from '../src/execute.js';
import { createAgentContext } from '../src/context.js';
import type { PolicyHandle } from '../src/policy.js';
import { asHost } from './hosts.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let paySrv: Awaited<ReturnType<typeof startFixtureServer>>;
let context: BrowserContext;
let page: Page;
let policy: PolicyHandle;

beforeAll(async () => {
  server = await startFixtureServer();
  paySrv = await startFixtureServer();
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  await paySrv?.close();
});

async function fresh() {
  const a = await createAgentContext(browser, { policy: { origin: server.url, allowedActions: 'full', authAllowlist: [] } });
  context = a.context;
  page = a.page;
  policy = a.policy!;
  await page.goto(`${server.url}/popup.html`);
  return { secrets: {}, origin: server.url, fixturesDir: '.' };
}

async function refOf(name: string): Promise<string> {
  const o = await observe(page);
  return o.interactables.find((x) => x.name === name)!.ref;
}

describe('popups', () => {
  it('same-origin target=_blank: popup closed and agent page navigates', async () => {
    const ctx = await fresh();
    const r = await execute(page, { type: 'click', ref: await refOf('Open same-origin'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(page.url()).toBe(`${server.url}/empty.html`);
    expect(context.pages()).toHaveLength(1);
    await context.close();
  });

  it('off-origin window.open: popup closed, navigation blocked and recorded, page unchanged', async () => {
    const ctx = await fresh();
    const r = await execute(page, { type: 'click', ref: await refOf('Open off-origin'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(page.url()).toBe(`${server.url}/popup.html`);
    // Without ctx.policy the click scope waits 400 ms; on a slow machine the context guard closes the popup instead.
    await expect.poll(() => context.pages().length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => policy.blocked.length, { timeout: 15_000 }).toBe(1);
    expect(policy.blocked[0]).toMatchObject({ kind: 'policy', method: 'GET', url: `http://foreign.test:${new URL(server.url).port}/empty.html` });
    await context.close();
  });

  it('a click whose popup navigation is blocked reports blocked_by_policy (popup frames count for the acting page)', async () => {
    const ctx = await fresh();
    const r = await execute(page, { type: 'click', ref: await refOf('Open off-origin'), intent: 'i' }, { ...ctx, policy });
    expect(r.outcome).toBe('blocked_by_policy');
    expect(policy.count()).toBe(1);
    expect(page.url()).toBe(`${server.url}/popup.html`);
    expect(context.pages()).toHaveLength(1);
    await context.close();
  });

  it('a click opening a popup straight to a payment checkout reports blocked_by_policy', async () => {
    const ctx = await fresh();
    const url = `${asHost(paySrv.url, 'checkout.stripe.com')}/pay`;
    const before = paySrv.connections();
    await page.evaluate(`(() => { const b = document.createElement('button'); b.textContent = 'Pay now'; b.onclick = () => window.open(${JSON.stringify(url)}, '_blank'); document.body.append(b); })()`);
    const r = await execute(page, { type: 'click', ref: await refOf('Pay now'), intent: 'i' }, { ...ctx, policy });
    expect(r.outcome).toBe('blocked_by_policy');
    expect(policy.blocked.map((b) => (b.kind === 'policy' ? b.url : ''))).toContain(url);
    expect(paySrv.connections()).toBe(before);
    await expect.poll(() => context.pages().length, { timeout: 15_000 }).toBe(1);
    await context.close();
  });

  it('a popup opened 1s after the click is closed by the context guard', async () => {
    const ctx = await fresh();
    let seen = false;
    context.on('page', () => (seen = true));
    // The popup opens only when the test releases the gate, i.e. after the click scope ended (no timing assumption).
    await page.evaluate(`window.lateGate = new Promise((r) => { window.releaseLate = r; }); 0`);
    const r = await execute(page, { type: 'click', ref: await refOf('Late popup'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(seen).toBe(false);
    await page.evaluate('window.releaseLate()');
    await expect.poll(() => seen, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => context.pages().length, { timeout: 15_000 }).toBe(1);
    expect(context.pages()).toHaveLength(1);
    expect(page.url()).toBe(`${server.url}/popup.html`);
    await context.close();
  });

  it('a popup that immediately navigates to a payment host is under policy from its first request', async () => {
    await fresh();
    const before = paySrv.connections();
    const url = `${asHost(paySrv.url, 'checkout.stripe.com')}/pay`;
    await page.evaluate(`window.open(${JSON.stringify(url)}, '_blank')`);
    await expect.poll(() => policy.blocked.length, { timeout: 15_000 }).toBe(1);
    expect(policy.blocked[0]).toMatchObject({ kind: 'policy', method: 'GET', url });
    await expect.poll(() => context.pages().length, { timeout: 15_000 }).toBe(1);
    expect(paySrv.connections()).toBe(before);
    await context.close();
  });
});

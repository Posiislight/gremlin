import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
import { execute } from '../src/execute.js';
import { createAgentContext } from '../src/context.js';
import type { PolicyHandle } from '../src/policy.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let context: BrowserContext;
let page: Page;
let policy: PolicyHandle;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
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
    expect(context.pages()).toHaveLength(1);
    expect(policy.blocked).toHaveLength(1);
    expect(policy.blocked[0]).toMatchObject({ kind: 'policy', method: 'GET', url: `http://127.0.0.2:${new URL(server.url).port}/empty.html` });
    await context.close();
  });

  it('with the policy handle in the exec context the blocked popup navigation is reported', async () => {
    const ctx = await fresh();
    const r = await execute(page, { type: 'click', ref: await refOf('Open off-origin'), intent: 'i' }, { ...ctx, policy });
    expect(r.outcome).toBe('blocked_by_policy');
    await context.close();
  });

  it('a popup opened 1s after the click is closed by the context guard', async () => {
    const ctx = await fresh();
    const r = await execute(page, { type: 'click', ref: await refOf('Late popup'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(context.pages()).toHaveLength(1);
    // The popup opens ~1s after the click, after the click scope ended; give the guard time to close it.
    let seen = false;
    context.on('page', () => (seen = true));
    await expect.poll(() => seen, { timeout: 3000 }).toBe(true);
    await expect.poll(() => context.pages().length, { timeout: 3000 }).toBe(1);
    expect(context.pages()).toHaveLength(1);
    expect(page.url()).toBe(`${server.url}/popup.html`);
    await context.close();
  });
});

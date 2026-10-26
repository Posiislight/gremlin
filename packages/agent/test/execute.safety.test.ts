import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
import { execute, type ExecContext } from '../src/execute.js';
import { createAgentContext } from '../src/context.js';
import { installPolicy, type PolicyHandle } from '../src/policy.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let page: Page;
let policy: PolicyHandle;
let ctx: ExecContext;

const SECRET = 'hunter2';
const EMAIL = 'alice@corp.com';

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  const a = await createAgentContext(browser, {
    policy: { origin: server.url, allowedActions: 'read_only', authAllowlist: [] },
  });
  page = a.page;
  policy = a.policy!;
  ctx = {
    secrets: { password: SECRET, 'persona:alice.email': EMAIL },
    origin: server.url,
    fixturesDir: join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
    policy,
  };
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function refOf(name: string): Promise<string> {
  const o = await observe(page);
  const i = o.interactables.find((x) => x.name === name);
  if (!i) throw new Error(`no interactable ${name}`);
  return i.ref;
}

describe('execute under a read_only policy', () => {
  it('a click that triggers a blocked POST reports blocked_by_policy and a recorded signal', async () => {
    await page.goto(`${server.url}/actions.html`);
    const before = policy.count();
    const r = await execute(page, { type: 'click', ref: await refOf('Post it'), intent: 'i' }, ctx);
    expect(r.outcome).toBe('blocked_by_policy');
    expect(policy.count()).toBe(before + 1);
    expect(policy.blocked[before]).toMatchObject({ kind: 'policy', method: 'POST', url: `${server.url}/api/hit` });
    const ok = await execute(page, { type: 'click', ref: await refOf('Increment'), intent: 'i' }, ctx);
    expect(ok.outcome).toBe('ok');
  });

  it('goto a foreign origin path is an error without any request', async () => {
    await page.goto(`${server.url}/actions.html`);
    const before = policy.count();
    const r = await execute(page, { type: 'goto', path: '/\\evil.example.com', intent: 'i' }, ctx);
    expect(r.outcome).toBe('error');
    expect(policy.count()).toBe(before);
  });
});

describe('redirect loops', () => {
  it('end with a plain error, not blocked_by_policy', async () => {
    // Own context: the Chromium error page lingers, and the shared agent context closes extra pages.
    const own = await browser.newContext();
    const ownPolicy = await installPolicy(own, { origin: server.url, allowedActions: 'read_only', authAllowlist: [] });
    const loopPage = await own.newPage();
    await loopPage.goto(`${server.url}/actions.html`);
    const r = await execute(loopPage, { type: 'goto', path: '/loop', intent: 'i' }, { ...ctx, policy: ownPolicy });
    const count = ownPolicy.count();
    await own.close();
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/ERR_TOO_MANY_REDIRECTS/);
    expect(count).toBe(0);
  });
});

describe('secrets never reach the result', () => {
  it('typing a secret into a contenteditable twice leaves it out of the whole result', async () => {
    await page.goto(`${server.url}/actions.html`);
    await observe(page);
    const ref = (await page.getAttribute('#ce', 'data-gremlin-ref'))!;
    for (let i = 0; i < 2; i++) {
      const r = await execute(page, { type: 'type', ref, text: '{{password}}', intent: 'i' }, ctx);
      expect(r.outcome).toBe('ok');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    expect(await page.textContent('#ce')).toBe(SECRET); // it really was typed
  });

  it('a persona email in an accessible name is dropped from the locator', async () => {
    await page.goto(`${server.url}/actions.html`);
    const r = await execute(page, { type: 'click', ref: await refOf(EMAIL), intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(r.locator).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain(EMAIL);
    expect(r.locator!.css).toMatch(/nth-child/);
  });

  it('typing into a disabled element fails without leaking the secret anywhere in the result', async () => {
    await page.goto(`${server.url}/actions.html`);
    const r = await execute(page, { type: 'type', ref: await refOf('Locked'), text: 'pw={{password}}', intent: 'i' }, ctx);
    expect(r.outcome).toBe('error');
    expect(r.error).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(SECRET);
  }, 20000);
});

describe('CSP without unsafe-eval', () => {
  it('click and type still produce locators', async () => {
    await page.goto(`${server.url}/csp.html`);
    // csp.js (allowed by script-src 'self') probes eval under the page's CSP.
    await page.waitForFunction(`document.body.dataset.eval !== undefined`);
    expect(await page.evaluate(`document.body.dataset.eval`)).toBe('blocked');
    const c = await execute(page, { type: 'click', ref: await refOf('CSP Button'), intent: 'i' }, ctx);
    expect(c.outcome).toBe('ok');
    expect(c.locator?.role).toEqual({ role: 'button', name: 'CSP Button' });
    const t = await execute(page, { type: 'type', ref: await refOf('CSP Text'), text: 'x', intent: 'i' }, ctx);
    expect(t.outcome).toBe('ok');
    expect(t.locator?.label).toBe('CSP Text');
  });
});

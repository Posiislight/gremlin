import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
import { execute, type ExecContext } from '../src/execute.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let page: Page;
let ctx: ExecContext;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  page = await browser.newPage();
  ctx = {
    secrets: { password: 'hunter2' },
    origin: server.url,
    fixturesDir: join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  };
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
beforeEach(async () => {
  await page.goto(`${server.url}/actions.html`);
});

async function refOf(name: string): Promise<string> {
  const o = await observe(page);
  const i = o.interactables.find((x) => x.name === name);
  if (!i) throw new Error(`no interactable ${name}`);
  return i.ref;
}

describe('execute', () => {
  it('click: testid button yields testId locator, plain yields role locator', async () => {
    const a = await execute(page, { type: 'click', ref: await refOf('Increment'), intent: 'i' }, ctx);
    expect(a.outcome).toBe('ok');
    expect(a.locator?.testId).toBe('inc-btn');
    expect(await page.locator('#count').textContent()).toBe('1');
    const b = await execute(page, { type: 'click', ref: await refOf('Plain Button'), intent: 'i' }, ctx);
    expect(b.outcome).toBe('ok');
    expect(b.locator?.testId).toBeUndefined();
    expect(b.locator?.role).toEqual({ role: 'button', name: 'Plain Button' });
    expect(b.locator?.css.length).toBeGreaterThan(0);
    expect(b.locator?.css).not.toContain('data-gremlin-ref');
    expect(await page.locator('#count').textContent()).toBe('11');
  });

  it('type with submit submits the form and echo receives the value', async () => {
    const r = await execute(page, { type: 'type', ref: await refOf('Message'), text: 'hello world', submit: true, intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    await page.waitForFunction("document.getElementById('result').textContent === 'hello world'");
  });

  it('type resolves placeholders and never leaks the secret in errors', async () => {
    const ref = await refOf('Message');
    const r = await execute(page, { type: 'type', ref, text: '{{password}}', intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(await page.inputValue('#msg')).toBe('hunter2');
    const bad = await execute(page, { type: 'type', ref, text: '{{nope}}', intent: 'i' }, ctx);
    expect(bad.outcome).toBe('error');
    expect(bad.error).toContain('{{nope}}');
    expect(bad.error).not.toContain('hunter2');
  });

  it('select, press, hover, scroll, wait', async () => {
    const s = await execute(page, { type: 'select', ref: await refOf('Color'), option: 'Green', intent: 'i' }, ctx);
    expect(s.outcome).toBe('ok');
    expect(await page.inputValue('#color')).toBe('g');
    const s2 = await execute(page, { type: 'select', ref: await refOf('Color'), option: 'b', intent: 'i' }, ctx);
    expect(s2.outcome).toBe('ok');
    expect(await page.inputValue('#color')).toBe('b');

    await page.focus('#keys');
    const p = await execute(page, { type: 'press', key: 'Enter', intent: 'i' }, ctx);
    expect(p.outcome).toBe('ok');
    expect(p.locator).toBeNull();
    expect(await page.textContent('#keyresult')).toBe('key:Enter');

    const h = await execute(page, { type: 'hover', ref: await refOf('Hover me'), intent: 'i' }, ctx);
    expect(h.outcome).toBe('ok');
    expect(await page.locator('#tip').isVisible()).toBe(true);

    const sc = await execute(page, { type: 'scroll', direction: 'down', intent: 'i' }, ctx);
    expect(sc.outcome).toBe('ok');
    expect(await page.evaluate('window.scrollY')).toBeGreaterThan(0);

    const t0 = Date.now();
    const w = await execute(page, { type: 'wait', ms: 100, intent: 'i' }, ctx);
    expect(w.outcome).toBe('ok');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('upload stays inside fixturesDir', async () => {
    const ref = await refOf('Attachment');
    const ok = await execute(page, { type: 'upload', ref, fixture: 'form.html', intent: 'i' }, ctx);
    expect(ok.outcome).toBe('ok');
    expect(await page.textContent('#fileresult')).toBe('form.html');
    const bad = await execute(page, { type: 'upload', ref, fixture: '../server.ts', intent: 'i' }, ctx);
    expect(bad.outcome).toBe('error');
  });

  it('goto, back, refresh', async () => {
    const g = await execute(page, { type: 'goto', path: '/form.html', intent: 'i' }, ctx);
    expect(g.outcome).toBe('ok');
    expect(new URL(page.url()).pathname).toBe('/form.html');
    const b = await execute(page, { type: 'back', intent: 'i' }, ctx);
    expect(b.outcome).toBe('ok');
    expect(new URL(page.url()).pathname).toBe('/actions.html');
    await page.evaluate("document.getElementById('count').textContent = '99'");
    const r = await execute(page, { type: 'refresh', intent: 'i' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(await page.textContent('#count')).toBe('0');
  });

  it('goto rejects off-origin escapes', async () => {
    const r = await execute(page, { type: 'goto', path: '/\\evil.example.com', intent: 'i' }, ctx);
    expect(r.outcome).toBe('error');
    expect(new URL(page.url()).pathname).toBe('/actions.html');
  });

  it('non-DOM actions do not touch the page', async () => {
    for (const a of [
      { type: 'expect', statement: 's', intent: 'i' },
      { type: 'report_bug', title: 't', expected: 'e', actual: 'a', severityHint: 'P2', intent: 'i' },
      { type: 'finish', reason: 'r', intent: 'i' },
    ] as const) {
      expect(await execute(page, a, ctx)).toEqual({ outcome: 'ok', locator: null });
    }
  });
});

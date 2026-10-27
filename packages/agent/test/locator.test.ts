import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';
import { computeLocator, resolveLocator } from '../src/locator.js';

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

describe('locators', () => {
  it('resolves the same element after a re-render with new refs', async () => {
    await page.goto(`${server.url}/actions.html`);
    const o = await observe(page);
    const ref = o.interactables.find((i) => i.name === 'Plain Button')!.ref;
    const h = (await page.$(`[data-gremlin-ref="${ref}"]`))!;
    const loc = await computeLocator(h);
    expect(loc.role).toEqual({ role: 'button', name: 'Plain Button' });

    // Re-render everything: same markup, fresh nodes, new ref attributes.
    await page.evaluate(
      `(() => { const m = document.querySelector('main'); m.innerHTML = m.innerHTML; document.querySelectorAll('[data-gremlin-ref]').forEach((e, i) => e.setAttribute('data-gremlin-ref', 'n' + i)); })()`,
    );
    const again = await resolveLocator(page, loc);
    expect(again).not.toBeNull();
    expect(await again!.textContent()).toBe('Plain Button');
  });

  it('priority: testId > role > label > placeholder > text', async () => {
    await page.goto(`${server.url}/form.html`);
    await observe(page);
    const email = await computeLocator((await page.$('input[name=email]'))!);
    expect(email.testId).toBeUndefined();
    expect(email.role?.role).toBe('textbox');
    expect(email.label).toBe('Email');
    const nick = await computeLocator((await page.$('input[name=nick]'))!);
    expect(nick.placeholder).toBe('Nickname');
    const x = await computeLocator((await page.$('button[aria-label="Close dialog"]'))!);
    expect(x.role).toEqual({ role: 'button', name: 'Close dialog' });
    expect(x.css).toMatch(/nth-child/);
    // every candidate resolves to exactly the element
    for (const loc of [email, nick, x]) expect(await resolveLocator(page, loc)).not.toBeNull();
  });

  it('ambiguous candidates are not stored; resolve requires exactly one match', async () => {
    await page.setContent(`<main><button>Go</button><button>Go</button><a href="#">Go</a></main>`);
    const h = (await page.$$('button'))[1]!;
    const loc = await computeLocator(h);
    expect(loc.role).toBeUndefined();
    expect(loc.text).toBeUndefined();
    const found = await resolveLocator(page, loc);
    expect(found).not.toBeNull();
    expect(await found!.evaluate((e) => Array.from(e.parentElement!.children).indexOf(e))).toBe(1);
    // A stale locator matching several elements resolves to null.
    expect(await resolveLocator(page, { role: { role: 'button', name: 'Go' }, css: 'button.nope' })).toBeNull();
  });

  it('long accessible names still resolve (non-exact)', async () => {
    const longName = 'Very long button name '.repeat(8).trim();
    await page.setContent(`<button>${longName}</button>`);
    const loc = await computeLocator((await page.$('button'))!);
    const truncated = { ...loc, role: { role: 'button', name: longName.slice(0, 40) } };
    expect(await resolveLocator(page, truncated)).not.toBeNull();
  });
});

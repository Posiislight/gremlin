import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe, estimateTokens } from '../src/observe.js';

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

describe('observe form.html', () => {
  it('extracts interactables, alerts and stable refs', async () => {
    await page.goto(`${server.url}/form.html`);
    const o = await observe(page);
    const email = o.interactables.find((i) => i.name === 'Email');
    expect(email?.role).toBe('textbox');
    expect(o.interactables.find((i) => i.name === 'Password')?.value).toBeUndefined();
    expect(o.interactables.find((i) => i.name === 'Nickname')).toBeTruthy();
    expect(o.interactables.find((i) => i.name === 'Save draft')?.disabled).toBe(true);
    expect(o.interactables.find((i) => i.name === 'Create account')?.disabled).toBe(false);
    expect(o.interactables.find((i) => i.name === 'Close dialog')?.role).toBe('button');
    expect(o.interactables.some((i) => /Hidden/.test(i.name))).toBe(false);
    expect(o.alerts).toEqual(['Email is required']);
    expect(o.title).toBe('Form fixture');
    expect(o.path).toBe('/form.html');
    expect(email?.section).toBeTruthy();

    const o2 = await observe(page);
    expect(o2.interactables.find((i) => i.name === 'Email')?.ref).toBe(email?.ref);
    expect(o2.stateHash).toBe(o.stateHash);
    expect(await page.locator(`[data-gremlin-ref="${email?.ref}"]`).count()).toBe(1);
  });

  it('never reassigns refs to different elements after DOM growth', async () => {
    await page.goto(`${server.url}/form.html`);
    const o1 = await observe(page);
    await page.evaluate(
      `(() => { const b = document.createElement('button'); b.textContent = 'Late'; document.querySelector('main').prepend(b); })()`,
    );
    const o2 = await observe(page);
    for (const i of o1.interactables) {
      expect(o2.interactables.find((j) => j.ref === i.ref)?.name).toBe(i.name);
    }
    const late = o2.interactables.find((i) => i.name === 'Late')!;
    expect(o1.interactables.some((i) => i.ref === late.ref)).toBe(false);
  });

  it('renders lines and diff mode', async () => {
    await page.goto(`${server.url}/form.html`);
    const o = await observe(page);
    expect(o.rendered).toMatch(/e\d+ button "Save draft" \[disabled\]/);
    expect(o.rendered).toContain('Email is required');
    expect(o.tokenEstimate).toBe(estimateTokens(o.rendered));
    const o2 = await observe(page, { previous: o });
    expect(o2.rendered).toContain(`(unchanged, ${o.interactables.length} elements)`);
    expect(o2.rendered).not.toContain('"Save draft"');
  });
});

describe('observe empty.html', () => {
  it('works on an empty page', async () => {
    await page.goto(`${server.url}/empty.html`);
    const o = await observe(page);
    expect(o.interactables).toEqual([]);
    expect(o.alerts).toEqual([]);
    expect(o.rendered.length).toBeGreaterThan(0);
  });
});

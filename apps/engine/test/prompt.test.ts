import { stripTypeScriptTypes } from 'node:module';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { playwrightTest } from '../src/mcp/prompt.js';
import { startFixtureServer } from './fixtureServer.js';

it('generated reproduction opens the target and fails on the real second cart save', async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    const source = playwrightTest({ id: 'cart', title: 'Second save fails', priority: 'P1', expected: 'Both saves succeed',
      actual: 'POST /api/cart returns 500', url: `${fixture.url}/cart.html`, oracle: 'network' }, [1, 2].map((n) => ({
        n, action: { type: 'click', ref: 'e1', intent: 'Add to cart' }, locator: { role: { role: 'button', name: 'Add to cart' }, css: '#add' }, intent: 'Add to cart',
      })), fixture.url);
    let run: ((args: { page: Page; baseURL?: string }) => Promise<void>) | undefined;
    const js = stripTypeScriptTypes(source.replace(/^import .*;\s*/m, ''));
    new Function('test', 'expect', js)((_name: string, fn: typeof run) => { run = fn; }, expect);
    await expect(run!({ page })).rejects.toMatchObject({ actual: [`500 ${fixture.url}/api/cart?n=2`] });
    expect(page.url()).toBe(`${fixture.url}/cart.html`);
  } finally { await browser.close(); await fixture.close(); }
}, 30_000);

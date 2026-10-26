import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { observe } from '../src/observe.js';

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

describe('sanitisation', () => {
  it('cannot forge interactable lines via values, names, sections, headings, alerts or title', async () => {
    await page.goto(`${server.url}/inject.html`);
    const o = await observe(page);
    const real = new Set(o.interactables.map((i) => i.ref));
    const refLines = o.rendered.split('\n').filter((l) => /^e\d+ /.test(l));
    expect(refLines.length).toBe(o.interactables.length);
    for (const l of refLines) expect(real.has(l.split(' ')[0]!)).toBe(true);
    expect(o.rendered).not.toMatch(/^e(99|98|88|77|66|55|44) /m);
    expect(o.interactables.find((i) => i.name === 'Notes')?.value).toContain('e99');
    expect(o.title).not.toContain('\n');
  });
});

describe('budget guard', () => {
  it('long names, values and alerts stay under 6000 tokens with a truthful count', async () => {
    await page.goto(`${server.url}/long.html`);
    const o = await observe(page);
    expect(o.tokenEstimate).toBeLessThanOrEqual(6000);
    for (const i of o.interactables) {
      expect(i.name.length).toBeLessThanOrEqual(80);
      expect((i.value ?? '').length).toBeLessThanOrEqual(80);
    }
    const m = o.rendered.match(/Interactables \((\d+)\) \(showing (\d+) of (\d+)\)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(o.interactables.length);
    expect(Number(m![2])).toBe(o.interactables.length);
    expect(Number(m![3])).toBe(160);
    expect(o.rendered.split('\n').filter((l) => /^e\d+ /.test(l)).length).toBe(o.interactables.length);
  });
});

describe('diff mode content awareness', () => {
  it('identical page is unchanged', async () => {
    await page.goto(`${server.url}/form.html`);
    const a = await observe(page);
    const b = await observe(page, { previous: a });
    expect(b.rendered).toContain(`(unchanged, ${a.interactables.length} elements)`);
  });
  it('disabled flip is not unchanged', async () => {
    await page.goto(`${server.url}/form.html`);
    const a = await observe(page);
    await page.evaluate(`document.querySelector('button[disabled]').disabled = false`);
    const b = await observe(page, { previous: a });
    expect(b.stateHash).toBe(a.stateHash);
    expect(b.rendered).not.toContain('(unchanged');
    expect(b.rendered).toContain('"Save draft"');
  });
  it('value change and checkbox toggle are not unchanged', async () => {
    await page.goto(`${server.url}/form.html`);
    const a = await observe(page);
    await page.fill('input[name=nick]', 'hello');
    const b = await observe(page, { previous: a });
    expect(b.rendered).not.toContain('(unchanged');
    expect(b.rendered).toContain('[value="hello"]');
    await page.setContent('<input type="checkbox" aria-label="Agree">');
    const c = await observe(page);
    await page.check('input');
    const d = await observe(page, { previous: c });
    expect(d.rendered).not.toContain('(unchanged');
    expect(d.rendered).toContain('[value="checked"]');
  });
  it('recreated elements get strictly greater refs, never reissued', async () => {
    await page.goto(`${server.url}/form.html`);
    const a = await observe(page);
    const maxA = Math.max(...a.interactables.map((i) => Number(i.ref.slice(1))));
    await page.evaluate(`document.body.innerHTML = '<main><button>One</button><button>Two</button></main>'`);
    const b = await observe(page, { previous: a });
    expect(b.rendered).not.toContain('(unchanged');
    for (const i of b.interactables) expect(Number(i.ref.slice(1))).toBeGreaterThan(maxA);
  });
});

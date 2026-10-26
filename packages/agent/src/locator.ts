import { readFileSync } from 'node:fs';
import type { ElementHandle, Frame, Locator as PwLocator, Page } from 'playwright';
import type { Locator } from '@gremlin/contract';

type Info = {
  testId: string | null;
  role: string | null;
  name: string;
  label: string | null;
  placeholder: string | null;
  text: string | null;
  css: string;
};

// Built in Node (not in the page) so no eval/new Function runs under the page's CSP; Playwright serialises
// the function's source and calls it with the element.
const COLLECT_SRC = readFileSync(new URL('./inject/locator.js', import.meta.url), 'utf8');
const collect = new Function('el', `return (${COLLECT_SRC})(el);`) as (el: unknown) => Info;

async function isSame(candidate: PwLocator, handle: ElementHandle): Promise<boolean> {
  try {
    if ((await candidate.count()) !== 1) return false;
    const found = await candidate.elementHandle({ timeout: 1000 });
    if (!found) return false;
    return await handle.evaluate((a, b) => a === b, found);
  } catch {
    return false;
  }
}

/** Derive a stored locator from the live element. Each field is stored only if it resolves to exactly this element. */
export async function computeLocator(handle: ElementHandle): Promise<Locator> {
  const info = (await handle.evaluate(collect as never)) as Info;
  const frame: Frame | null = await handle.ownerFrame();
  const out: Locator = { css: info.css };
  if (!frame) return out;

  if (info.testId && (await isSame(frame.getByTestId(info.testId), handle))) out.testId = info.testId;
  if (info.role && info.name) {
    const loc = frame.getByRole(info.role as Parameters<Frame['getByRole']>[0], { name: info.name });
    if (await isSame(loc, handle)) out.role = { role: info.role, name: info.name };
  }
  if (info.label && (await isSame(frame.getByLabel(info.label), handle))) out.label = info.label;
  if (info.placeholder && (await isSame(frame.getByPlaceholder(info.placeholder), handle))) out.placeholder = info.placeholder;
  if (info.text && (await isSame(frame.getByText(info.text), handle))) out.text = info.text;
  return out;
}

async function uniqueHandle(candidate: PwLocator): Promise<ElementHandle | null> {
  try {
    if ((await candidate.count()) !== 1) return null;
    return await candidate.elementHandle({ timeout: 1000 });
  } catch {
    return null;
  }
}

/** Try testId > role+name > label > placeholder > text > css; return a handle only if exactly one element matches. */
export async function resolveLocator(page: Page, loc: Locator): Promise<ElementHandle | null> {
  const tries: Array<() => PwLocator> = [];
  if (loc.testId) tries.push(() => page.getByTestId(loc.testId!));
  if (loc.role) tries.push(() => page.getByRole(loc.role!.role as Parameters<Page['getByRole']>[0], { name: loc.role!.name }));
  if (loc.label) tries.push(() => page.getByLabel(loc.label!));
  if (loc.placeholder) tries.push(() => page.getByPlaceholder(loc.placeholder!));
  if (loc.text) tries.push(() => page.getByText(loc.text!));
  tries.push(() => page.locator(loc.css));
  for (const t of tries) {
    const h = await uniqueHandle(t());
    if (h) return h;
  }
  return null;
}

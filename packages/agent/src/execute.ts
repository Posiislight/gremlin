import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ElementHandle, Page } from 'playwright';
import type { Action, Locator, StepOutcome } from '@gremlin/contract';
import { computeLocator } from './locator.js';
import { redact, resolvePlaceholders } from './secrets.js';
import { trackRequests } from './settle.js';
import { clickScopes } from './context.js';

export type ExecContext = {
  secrets: Record<string, string>;
  origin: string;
  fixturesDir: string;
  /** Policy handle from installPolicy/createAgentContext; lets execute() report `blocked_by_policy`. */
  policy?: { count(): number } | null;
};
export type ExecResult = { outcome: StepOutcome; locator: Locator | null; error?: string };

const ACTION_TIMEOUT = 5000;
const POPUP_WAIT_MS = 400;
// A link that declares target=_blank is certain to open a popup, so wait longer for it (slow machines).
const POPUP_LINK_WAIT_MS = 3000;
// Built in Node, serialised by Playwright (no eval inside the page; see locator.ts).
const declaresBlankTarget = new Function(
  'el',
  `const a = el.closest('a[target]'); return !!a && !['_self', '_parent', '_top', ''].includes(a.target);`,
) as (el: unknown) => boolean;

function fail(error: string): ExecResult {
  return { outcome: 'error', locator: null, error };
}

async function findRef(page: Page, ref: string): Promise<ElementHandle | null> {
  if (!/^e\d+$/.test(ref)) return null;
  return page.$(`[data-gremlin-ref="${ref}"]`);
}

/** Click, then give a popup up to POPUP_WAIT_MS to appear; close it and follow same-origin targets in the agent page. */
async function clickWithPopups(page: Page, handle: ElementHandle, ctx: ExecContext): Promise<void> {
  const context = page.context();
  const opened: Page[] = [];
  let wake: (() => void) | null = null;
  const onPage = (p: Page) => {
    opened.push(p);
    wake?.();
  };
  context.on('page', onPage);
  clickScopes.set(context, (clickScopes.get(context) ?? 0) + 1);
  try {
    const declaresBlank = await handle.evaluate(declaresBlankTarget as never).catch(() => false);
    await handle.click({ timeout: ACTION_TIMEOUT });
    if (opened.length === 0) {
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, declaresBlank ? POPUP_LINK_WAIT_MS : POPUP_WAIT_MS);
        wake = () => {
          clearTimeout(timer);
          resolveWait();
        };
      });
    }
    for (const popup of opened) {
      let target = '';
      try {
        await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 2000, waitUntil: 'domcontentloaded' });
        target = popup.url();
      } catch {
        /* never loaded; just close it */
      }
      await popup.close().catch(() => undefined);
      if (target && sameOriginAs(target, ctx.origin)) {
        await page.goto(target, { timeout: 10000 });
      }
    }
  } finally {
    clickScopes.set(context, (clickScopes.get(context) ?? 1) - 1);
    context.off('page', onPage);
  }
}

function sameOriginAs(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function insideDir(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Drop locator candidates that contain a secret value (>= 3 chars): persona emails in accessible names,
 * typed text echoed into editors, etc. The field is removed, not redacted, so the stored locator never
 * carries the secret; resolution falls through to the remaining candidates / css.
 */
function scrubLocator(loc: Locator, secrets: Record<string, string>): Locator {
  const vals = Object.values(secrets).filter((v) => v.length >= 3);
  const leaks = (s: string | undefined) => !!s && vals.some((v) => s.includes(v) || s.toLowerCase().includes(v.toLowerCase()));
  const out: Locator = { css: loc.css };
  if (loc.testId && !leaks(loc.testId)) out.testId = loc.testId;
  if (loc.role && !leaks(loc.role.name)) out.role = loc.role;
  if (loc.label && !leaks(loc.label)) out.label = loc.label;
  if (loc.placeholder && !leaks(loc.placeholder)) out.placeholder = loc.placeholder;
  if (loc.text && !leaks(loc.text)) out.text = loc.text;
  return out;
}

export async function execute(page: Page, action: Action, ctx: ExecContext): Promise<ExecResult> {
  const before = ctx.policy?.count() ?? 0;
  const r = await executeInner(page, action, ctx);
  if (!ctx.policy) return r;
  await page.waitForTimeout(100).catch(() => undefined); // let in-flight route handlers record their abort
  const n = ctx.policy.count() - before;
  if (n > 0) return { outcome: 'blocked_by_policy', locator: r.locator, error: `blocked by policy (${n} request${n === 1 ? '' : 's'})` };
  return r;
}

async function executeInner(page: Page, action: Action, ctx: ExecContext): Promise<ExecResult> {
  let resolvedText: string | null = null;
  trackRequests(page);
  try {
    switch (action.type) {
      case 'expect':
      case 'report_bug':
      case 'finish':
        return { outcome: 'ok', locator: null };

      case 'press':
        await page.keyboard.press(action.key);
        return { outcome: 'ok', locator: null };

      case 'scroll':
        await page.evaluate(`window.scrollBy(0, ${action.direction === 'down' ? 1 : -1} * Math.round(window.innerHeight * 0.8))`);
        return { outcome: 'ok', locator: null };

      case 'goto': {
        const url = new URL(action.path, ctx.origin);
        if (url.origin !== new URL(ctx.origin).origin) return fail(`goto ${action.path} leaves the target origin`);
        await page.goto(url.href, { timeout: 15000 });
        return { outcome: 'ok', locator: null };
      }
      case 'back':
        await page.goBack({ timeout: 10000 });
        return { outcome: 'ok', locator: null };
      case 'refresh':
        await page.reload({ timeout: 15000 });
        return { outcome: 'ok', locator: null };
      case 'wait':
        await page.waitForTimeout(action.ms);
        return { outcome: 'ok', locator: null };

      default:
        break;
    }

    // Ref-based actions.
    const handle = await findRef(page, action.ref);
    if (!handle) return fail(`ref ${action.ref} not found`);
    const locator = scrubLocator(await computeLocator(handle), ctx.secrets);

    switch (action.type) {
      case 'click':
        await clickWithPopups(page, handle, ctx);
        break;
      case 'type':
        resolvedText = resolvePlaceholders(action.text, ctx.secrets);
        await handle.fill(resolvedText, { timeout: ACTION_TIMEOUT });
        if (action.submit) await handle.press('Enter', { timeout: ACTION_TIMEOUT });
        break;
      case 'select':
        await handle.selectOption([{ label: action.option }, { value: action.option }], { timeout: ACTION_TIMEOUT });
        break;
      case 'hover':
        await handle.hover({ timeout: ACTION_TIMEOUT });
        break;
      case 'upload': {
        const file = join(ctx.fixturesDir, action.fixture);
        if (!insideDir(ctx.fixturesDir, file)) return fail(`fixture ${action.fixture} is outside the fixtures directory`);
        await handle.setInputFiles(file, { timeout: ACTION_TIMEOUT });
        break;
      }
    }
    return { outcome: 'ok', locator };
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    // Never let a resolved secret reach the result, and show the unresolved placeholder text only.
    if (resolvedText && action.type === 'type' && resolvedText.length > 0) msg = msg.split(resolvedText).join(action.text);
    return fail(redact(msg, ctx.secrets).split('\n')[0]!);
  }
}

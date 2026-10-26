import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { installPolicy, markServiceWorkersBlocked, type PolicyHandle, type PolicyOptions } from './policy.js';

/** Number of click scopes currently inspecting popups on a context (see execute.ts). The late-popup guard stays out of their way. */
export const clickScopes = new WeakMap<BrowserContext, number>();

export type AgentContextOptions = Omit<BrowserContextOptions, 'serviceWorkers'> & {
  /** Install the network safety policy (spec §14) on the new context. */
  policy?: PolicyOptions;
};

/**
 * Create the browser context an agent must run in. Callers MUST use this (not `browser.newContext()`):
 * - `serviceWorkers: 'block'`: a service worker could answer requests from its cache/fetch without ever hitting
 *   the policy routes.
 * - A persistent popup guard closes every page the context creates other than the agent's own page (popups
 *   opened late, e.g. from a timer, included). execute() still follows same-origin popups opened as a direct
 *   result of a click, by handling them inside the click scope.
 * - Options such as `recordVideo`, `storageState`, `viewport` are passed through.
 */
export async function createAgentContext(
  browser: Browser,
  opts: AgentContextOptions = {},
): Promise<{ context: BrowserContext; page: Page; policy: PolicyHandle | null }> {
  const { policy: policyOpts, ...ctxOpts } = opts;
  const context = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
  markServiceWorkersBlocked(context);
  const policy = policyOpts ? await installPolicy(context, policyOpts) : null;
  const page = await context.newPage();
  context.on('page', (p) => {
    if (p === page) return;
    if ((clickScopes.get(context) ?? 0) > 0) return; // the click scope closes what it sees
    void p.close().catch(() => undefined);
  });
  return { context, page, policy };
}

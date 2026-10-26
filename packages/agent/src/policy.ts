import type { BrowserContext } from 'playwright';
import type { Signal } from '@gremlin/contract';
import { decideRequest, safeUrl, validateOptions, type PolicyOptions } from './decide.js';
import { BrowserInterceptor, contextIdOf, type InterceptClient } from './intercept.js';

export type { PolicyOptions } from './decide.js';

export type PolicyHandle = {
  /** Every request the policy denied (payment hosts, foreign navigations, read_only writes, WS). */
  blocked: Signal[];
  /** Parallel to `blocked`: CDP resource type, whether it was a redirect hop, and whether the URL had a query/fragment (stripped for hops). */
  details: Array<{ resourceType: string; isRedirect: boolean; hadQuery: boolean }>;
  /** Number of blocked requests so far; execute() diffs it around an action. */
  count(): number;
  /** Requests currently held paused by the interceptor for this browser (should return to 0 when idle). */
  paused(): number;
  /** Stop enforcing (also done when the context closes). */
  dispose(): Promise<void>;
};

/**
 * Network-layer safety (spec §14). Rules live in decide.ts (`decideRequest`, pure); this file wires them to
 * Chromium.
 *
 * Mechanism: a CDP `Fetch.enable` interceptor (intercept.ts) pauses every request AND every redirect hop;
 * allowed requests are continued untouched (Chromium performs request and redirect natively, so page URL,
 * cookies, streaming, SameSite and address-space behaviour are exactly the browser's), denied ones fail with
 * `BlockedByClient` and are recorded as `policy` signals (redirect hops are recorded without query string).
 * WebSocket handshakes are not visible to Fetch and are routed with Playwright's `context.routeWebSocket`.
 *
 * Limitations:
 * - Chromium only (CDP). Navigation to non-http(s) schemes and bfcache restores issue no request, so they are
 *   not judged.
 * - Service workers must be blocked: use createAgentContext (serviceWorkers: 'block'), otherwise a worker could
 *   answer requests without a network fetch, and its own requests cannot be attributed to the context.
 * - Requests that cannot be attributed to a policy context (e.g. shared workers) are not judged.
 * - A read_only auth allowlist is matched on pathname segment boundaries; apiHosts/extraHosts are matched on
 *   host (and port when given).
 */
export async function installPolicy(context: BrowserContext, opts: PolicyOptions): Promise<PolicyHandle> {
  validateOptions(opts);
  const browser = context.browser();
  if (!browser) throw new Error('installPolicy needs a context created from a Browser (not a persistent context)');
  const now = opts.now ?? Date.now;
  const t0 = now();
  const blocked: Signal[] = [];
  const details: PolicyHandle['details'] = [];

  const deny = (method: string, url: string, resourceType: string, isRedirect: boolean) => {
    const s = safeUrl(url, isRedirect);
    blocked.push({ kind: 'policy', method, url: s.url, tMs: now() - t0 });
    details.push({ resourceType, isRedirect, hadQuery: s.hadQuery });
  };

  const contextId = await contextIdOf(context);
  const client: InterceptClient = {
    contextId,
    context,
    allow(req) {
      let allowed: boolean;
      try {
        allowed = decideRequest(req, opts).allow;
      } catch {
        allowed = false; // a rule bug must fail closed
      }
      if (!allowed) deny(req.method, req.url, req.resourceType, req.isRedirect);
      return allowed;
    },
  };
  const interceptor = await BrowserInterceptor.for(browser);
  await interceptor.register(client);

  await context.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    if (!decideRequest({ url, method: 'WS', resourceType: 'WebSocket', isRedirect: false }, opts).allow) {
      deny('WS', url, 'WebSocket', false);
      void ws.close({ code: 1008, reason: 'blocked by policy' });
      return;
    }
    ws.connectToServer();
  });

  let disposed: Promise<void> | null = null;
  const dispose = () => (disposed ??= interceptor.unregister(contextId));
  context.once('close', () => void dispose());

  return { blocked, details, count: () => blocked.length, paused: () => interceptor.paused(), dispose };
}

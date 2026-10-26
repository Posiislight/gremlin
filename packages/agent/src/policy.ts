import type { BrowserContext, Page } from 'playwright';
import type { Signal } from '@gremlin/contract';
import { decideRequest, safeUrl, validateOptions, type PolicyOptions } from './decide.js';
import { BrowserInterceptor, contextIdOf, type InterceptClient } from './intercept.js';

export type { PolicyOptions } from './decide.js';

const swBlocked = new WeakSet<BrowserContext>();

/** Declare that `context` was created with `serviceWorkers: 'block'` (createAgentContext does this). */
export function markServiceWorkersBlocked(context: BrowserContext): void {
  swBlocked.add(context);
}

export type PolicyHandle = {
  /** Every request the policy denied (payment hosts, foreign navigations, read_only writes, WS). */
  blocked: Signal[];
  /** Parallel to `blocked`: CDP resource type, whether it was a redirect hop, and whether the URL had a query/fragment (stripped for hops). */
  details: Array<{ resourceType: string; isRedirect: boolean; hadQuery: boolean; frameId: string | undefined; reason: string }>;
  /** Number of blocked requests so far; execute() diffs it around an action. */
  count(): number;
  /** Blocks recorded after `since` (a `count()` snapshot) whose frame belongs to the page's current frame tree. */
  blockedFor(page: Page, since: number): Promise<number>;
  /** True while Chromium-level interception is switched on for this browser. */
  active(): boolean;
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
 *   installPolicy warns (or throws with `requireSwBlock`) for contexts not marked via markServiceWorkersBlocked.
 * - Requests that cannot be attributed to any context (closed targets are tombstoned for 60 s, so closing pages
 *   are attributed; e.g. shared workers are not) FAIL CLOSED when some registered policy would deny them.
 * - A read_only auth allowlist is matched on pathname segment boundaries; apiHosts/extraHosts are matched on
 *   host (and port when given).
 */
export async function installPolicy(context: BrowserContext, opts: PolicyOptions): Promise<PolicyHandle> {
  validateOptions(opts);
  if (!swBlocked.has(context)) {
    const msg = "installPolicy: this context was not created with serviceWorkers: 'block' (use createAgentContext); a service worker can answer requests without a network fetch";
    if (opts.requireSwBlock) throw new Error(msg);
    console.warn(msg);
  }
  const browser = context.browser();
  if (!browser) throw new Error('installPolicy needs a context created from a Browser (not a persistent context)');
  const now = opts.now ?? Date.now;
  const t0 = now();
  const blocked: Signal[] = [];
  const details: PolicyHandle['details'] = [];

  const deny = (method: string, url: string, resourceType: string, isRedirect: boolean, frameId: string | undefined, reason: string) => {
    const s = safeUrl(url, isRedirect);
    blocked.push({ kind: 'policy', method, url: s.url, tMs: now() - t0 });
    details.push({ resourceType, isRedirect, hadQuery: s.hadQuery, frameId, reason });
  };

  const contextId = await contextIdOf(context);
  const client: InterceptClient = {
    contextId,
    context,
    decide(req) {
      try {
        return decideRequest(req, opts);
      } catch {
        return { allow: false, reason: 'policy rule error' }; // a rule bug must fail closed
      }
    },
    record(req, reason) {
      deny(req.method, req.url, req.resourceType, req.isRedirect, req.frameId, reason);
    },
  };
  const interceptor = await BrowserInterceptor.for(browser);
  await interceptor.register(client);

  await context.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    if (!decideRequest({ url, method: 'WS', resourceType: 'WebSocket', isRedirect: false }, opts).allow) {
      deny('WS', url, 'WebSocket', false, undefined, 'websocket');
      void ws.close({ code: 1008, reason: 'blocked by policy' });
      return;
    }
    ws.connectToServer();
  });

  let disposed: Promise<void> | null = null;
  const dispose = () => (disposed ??= interceptor.unregister(contextId));
  context.once('close', () => void dispose());

  const blockedFor = async (page: Page, since: number) => {
    const frames = await interceptor.frameIdsOf(page);
    return details.slice(since).filter((d) => d.frameId !== undefined && frames.has(d.frameId)).length;
  };

  return { blocked, details, count: () => blocked.length, blockedFor, active: () => interceptor.active(), paused: () => interceptor.paused(), dispose };
}

import type { BrowserContext, Request, Route } from 'playwright';
import { getDomain } from 'tldts';
import type { Signal } from '@gremlin/contract';

export type PolicyOptions = {
  /** Target origin, e.g. `http://127.0.0.1:3000`. */
  origin: string;
  allowedActions: 'read_only' | 'full';
  /** Path prefixes (segment-boundary match against pathname) that stay writable in read_only, e.g. `/api/login`. */
  authAllowlist: string[];
  /** Extra hostnames (or host:port) that count as part of the target: navigable, and write-protected in read_only. */
  extraHosts?: string[];
  /** Hosts (exact, or `*.suffix`) of the app's own API that must be write-protected in read_only. */
  apiHosts?: string[];
  /** Clock override for tests; default Date.now. */
  now?: () => number;
};

export type PolicyHandle = {
  /** Every request the policy aborted (payment hosts, foreign navigations, read_only writes, WS). */
  blocked: Signal[];
  /** Number of blocked requests so far; execute() diffs it around an action. */
  count(): number;
};

const PAYMENT_HOSTS = ['stripe.com', 'checkout.stripe.com', 'paypal.com', 'adyen.com', 'squareup.com'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const MAX_HOPS = 10;

/** Lowercase, drop IPv6 brackets and any trailing dot (`stripe.com.` is stripe.com). */
export function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function isPaymentHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  return PAYMENT_HOSTS.some((p) => h === p || h.endsWith('.' + p));
}

function matchesHostList(host: string, port: string, list: string[]): boolean {
  return list.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) return host.endsWith(e.slice(1));
    return normalizeHost(e) === host || e === `${host}:${port}`;
  });
}

function pathAllowed(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'));
}

/**
 * Network-layer safety (spec §14).
 *
 * Site model: the target's SITE is its registrable domain (eTLD+1 via tldts, private suffixes separate), or,
 * when the target is a loopback host (localhost / 127.0.0.1 / ::1), every loopback alias on ANY port (local
 * services all belong to the dev machine). `extraHosts` and `apiHosts` join the write-protected set.
 *
 * - read_only: non-GET/HEAD requests to the target site (or extra/api hosts) are aborted unless the pathname
 *   matches an auth-allowlist prefix on a path-segment boundary. Non-GET to genuinely third-party sites is
 *   allowed in both modes (read_only only constrains the target site).
 * - Document requests (navigations, iframes) to a different site than the target (or extraHosts) are aborted.
 * - Payment hosts are always aborted. Hostnames are normalised (case, trailing dot).
 * - Redirects: Playwright does not run route handlers for redirect hops, so DOCUMENT requests and (in
 *   read_only) every non-GET/HEAD request are fetched with `maxRedirects: 0` and the hops followed manually,
 *   each re-checked, before the final response is fulfilled. Consequence: the page URL of a redirected
 *   document stays the originally requested URL. Other subresource redirects cannot be intercepted; a
 *   `context.on('request')` backstop records a policy signal for violating hops and sends the offending page
 *   to about:blank (the hop may already have reached the network - known limitation).
 * - WebSockets are routed: payment hosts and (read_only) target-site sockets are closed and recorded.
 *
 * Callers must also create the context with `serviceWorkers: 'block'` (see createAgentContext).
 * Routes use `fallback()`, so handlers registered earlier by the caller still run for allowed requests.
 */
export async function installPolicy(context: BrowserContext, opts: PolicyOptions): Promise<PolicyHandle> {
  for (const p of opts.authAllowlist) {
    if (!p.startsWith('/') || p === '/') throw new Error(`invalid authAllowlist entry "${p}": must be a non-root path starting with "/"`);
  }
  const now = opts.now ?? Date.now;
  const t0 = now();
  const blocked: Signal[] = [];
  const handled = new WeakSet<Request>();
  const readOnly = opts.allowedActions === 'read_only';
  const target = new URL(opts.origin);
  const targetHost = normalizeHost(target.hostname);
  const targetLoopback = LOOPBACK.has(targetHost);
  const targetDomain = getDomain(targetHost, { allowPrivateDomains: true });
  const extra = opts.extraHosts ?? [];
  const api = opts.apiHosts ?? [];

  const inTargetSite = (u: URL): boolean => {
    const h = normalizeHost(u.hostname);
    if (targetLoopback) return LOOPBACK.has(h);
    if (h === targetHost) return true;
    if (!targetDomain) return false;
    return getDomain(h, { allowPrivateDomains: true }) === targetDomain;
  };
  const isExtra = (u: URL) => matchesHostList(normalizeHost(u.hostname), u.port, extra);
  const navigable = (u: URL) => inTargetSite(u) || isExtra(u);
  const writeProtected = (u: URL) => inTargetSite(u) || isExtra(u) || matchesHostList(normalizeHost(u.hostname), u.port, api);

  const violation = (u: URL, method: string, type: string): boolean => {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPaymentHost(u.hostname)) return true;
    if (type === 'document' && !navigable(u)) return true;
    if (readOnly && !SAFE_METHODS.has(method) && writeProtected(u) && !pathAllowed(u.pathname, opts.authAllowlist)) return true;
    return false;
  };

  const record = (method: string, url: string) => {
    blocked.push({ kind: 'policy', method, url, tMs: now() - t0 });
  };

  const parse = (s: string): URL | null => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  };

  const manualFollow = async (route: Route, first: URL, method: string, type: string) => {
    const req = route.request();
    const post = req.postDataBuffer();
    let cur = first;
    let m = method;
    let body: Buffer | null = post;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (violation(cur, m, type)) {
        handled.add(req);
        record(m, cur.href);
        await route.abort('blockedbyclient');
        return;
      }
      let resp;
      try {
        resp = await route.fetch({ url: cur.href, method: m, postData: body ?? undefined, maxRedirects: 0 });
      } catch {
        await route.abort('failed').catch(() => undefined);
        return;
      }
      const loc = resp.headers()['location'];
      if ([301, 302, 303, 307, 308].includes(resp.status()) && loc) {
        const next = parse(new URL(loc, cur).href);
        if (!next) break;
        const s = resp.status();
        if (s === 303 || ((s === 301 || s === 302) && m === 'POST')) {
          m = 'GET';
          body = null;
        }
        cur = next;
        continue;
      }
      await route.fulfill({ response: resp });
      return;
    }
    handled.add(req);
    record(m, cur.href); // redirect loop / too many hops
    await route.abort('blockedbyclient');
  };

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = parse(req.url());
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return route.fallback();
    const method = req.method().toUpperCase();
    const type = req.resourceType();
    if (type === 'document' || (readOnly && !SAFE_METHODS.has(method))) return manualFollow(route, url, method, type);
    if (violation(url, method, type)) {
      handled.add(req);
      record(method, req.url());
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });

  // Backstop for redirect hops of continued subresources (cannot be intercepted, see doc above).
  context.on('request', (req) => {
    if (!req.redirectedFrom() || handled.has(req)) return;
    const url = parse(req.url());
    if (!url || !violation(url, req.method().toUpperCase(), req.resourceType())) return;
    handled.add(req);
    record(req.method().toUpperCase(), req.url());
    try {
      void req.frame().page()?.goto('about:blank').catch(() => undefined);
    } catch {
      /* frame detached */
    }
  });

  await context.routeWebSocket(/.*/, (ws) => {
    const u = parse(ws.url().replace(/^ws/i, 'http'));
    if (u && (isPaymentHost(u.hostname) || (readOnly && writeProtected(u)))) {
      record('WS', ws.url());
      void ws.close({ code: 1008, reason: 'blocked by policy' });
      return;
    }
    ws.connectToServer();
  });

  return { blocked, count: () => blocked.length };
}

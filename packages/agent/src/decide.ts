import { getDomain } from 'tldts';

export type PolicyOptions = {
  /** Target origin, e.g. `http://127.0.0.1:3000`. */
  origin: string;
  allowedActions: 'read_only' | 'full';
  /** Path prefixes (segment-boundary match against pathname) that stay writable in read_only, e.g. `/api/login`. */
  authAllowlist: string[];
  /** Extra hosts that count as part of the target: navigable, and write-protected in read_only. Entries: `host`, `host:port`, `[::1]:3000`, `*.suffix`. */
  extraHosts?: string[];
  /** Hosts of the app's own API that must be write-protected in read_only. Same entry syntax as extraHosts. */
  apiHosts?: string[];
  /** Throw instead of warning when the context is not marked as created with serviceWorkers: 'block'. */
  requireSwBlock?: boolean;
  /** Clock override for tests; default Date.now. */
  now?: () => number;
};

export type DecideRequest = {
  url: string;
  /** HTTP method; `WS` for a WebSocket handshake. */
  method: string;
  /** CDP resource type (`Document`, `XHR`, `Fetch`, `Image`, `Preflight`, `WebSocket`, ...); case-insensitive. */
  resourceType: string;
  /** True when this request is a redirect hop of an earlier request. */
  isRedirect: boolean;
  /** URL of the frame that issued the request, when known. Not used by the current rules. */
  frameUrl?: string;
};

export type Decision = { allow: true } | { allow: false; reason: string };

const PAYMENT_HOSTS = ['stripe.com', 'checkout.stripe.com', 'paypal.com', 'adyen.com', 'squareup.com'];
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Lowercase, drop IPv6 brackets and any trailing dot (`stripe.com.` is stripe.com). */
export function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** 127.0.0.0/8, ::1, localhost and *.localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isPaymentHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  return PAYMENT_HOSTS.some((p) => h === p || h.endsWith('.' + p));
}

const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

function matchesHostList(u: URL, list: string[]): boolean {
  const host = normalizeHost(u.hostname);
  const port = u.port || DEFAULT_PORT[u.protocol] || '';
  return list.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (e.startsWith('*.')) return host.endsWith(e.slice(1));
    let eh = e;
    let ep = '';
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(e);
    if (v6) {
      eh = v6[1]!;
      ep = v6[2] ?? '';
    } else if (/^[^:]+:\d+$/.test(e)) {
      [eh, ep] = e.split(':') as [string, string];
    }
    return normalizeHost(eh) === host && (ep === '' || ep === port);
  });
}

function pathAllowed(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'));
}

/** Throws if an auth-allowlist entry is not a non-root absolute path. */
export function validateOptions(opts: Pick<PolicyOptions, 'authAllowlist'>): void {
  for (const p of opts.authAllowlist) {
    if (!p.startsWith('/') || p === '/') throw new Error(`invalid authAllowlist entry "${p}": must be a non-root path starting with "/"`);
  }
}

/** Origin without query/fragment, for signals of redirect hops (tokens often live in query strings). */
export function safeUrl(url: string, stripQuery: boolean): { url: string; hadQuery: boolean } {
  try {
    const u = new URL(url);
    const hadQuery = u.search !== '' || u.hash !== '';
    return stripQuery && hadQuery ? { url: u.origin + u.pathname, hadQuery } : { url, hadQuery };
  } catch {
    return { url, hadQuery: false };
  }
}

/**
 * All safety rules (spec §14) as a pure function of one request.
 *
 * Site model: the target's SITE is its registrable domain (eTLD+1 via tldts, private suffixes separate) or,
 * when the target is a loopback host, every loopback host (127.0.0.0/8, ::1, localhost, *.localhost) on ANY port
 * (local services all belong to the dev machine). `extraHosts` and `apiHosts` join the write-protected set.
 *
 * - Payment hosts (stripe.com, checkout.stripe.com, paypal.com, adyen.com, squareup.com and subdomains) are
 *   always denied, whatever the type or mode.
 * - Document requests (navigations, iframes) to another site than the target / extraHosts are denied.
 * - read_only: non-GET/HEAD requests to the target site (or extra/api hosts) are denied unless the pathname
 *   matches an auth-allowlist prefix on a segment boundary. CORS preflights (`Preflight`) do not mutate and are
 *   treated as safe. Non-GET to genuinely third-party sites is allowed in both modes (read_only only constrains
 *   the target site).
 * - Non-http(s)/ws(s) URLs are not judged.
 */
export function decideRequest(req: DecideRequest, opts: PolicyOptions): Decision {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { allow: true };
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return { allow: true };

  const hop = req.isRedirect ? ' (redirect hop)' : '';
  if (isPaymentHost(u.hostname)) return { allow: false, reason: `payment host ${normalizeHost(u.hostname)}${hop}` };

  const target = new URL(opts.origin);
  const targetHost = normalizeHost(target.hostname);
  const targetLoopback = isLoopbackHost(targetHost);
  const targetDomain = getDomain(targetHost, { allowPrivateDomains: true });
  const extra = opts.extraHosts ?? [];
  const api = opts.apiHosts ?? [];

  const host = normalizeHost(u.hostname);
  const inTargetSite = targetLoopback
    ? isLoopbackHost(host)
    : host === targetHost || (targetDomain !== null && getDomain(host, { allowPrivateDomains: true }) === targetDomain);
  const isExtra = matchesHostList(u, extra);

  if (req.resourceType.toLowerCase() === 'document' && !inTargetSite && !isExtra) {
    return { allow: false, reason: `navigation to another site ${host}${hop}` };
  }

  const type = req.resourceType.toLowerCase();
  const method = req.method.toUpperCase();
  const mutating = !SAFE_METHODS.has(method) && type !== 'preflight';
  if (opts.allowedActions === 'read_only' && mutating && (inTargetSite || isExtra || matchesHostList(u, api))) {
    if (!pathAllowed(u.pathname, opts.authAllowlist)) return { allow: false, reason: `read_only blocks ${method} to ${host}${hop}` };
  }
  return { allow: true };
}

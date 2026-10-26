import type { BrowserContext } from 'playwright';
import type { Signal } from '@gremlin/contract';

export type PolicyOptions = {
  /** Target origin, e.g. `http://127.0.0.1:3000`. */
  origin: string;
  allowedActions: 'read_only' | 'full';
  /** Path prefixes (matched against pathname) that stay writable in read_only, e.g. `/api/login`. */
  authAllowlist: string[];
  /** Extra hostnames (or host:port) that navigation may reach. */
  extraHosts?: string[];
  /** Clock override for tests; default Date.now. */
  now?: () => number;
};

const PAYMENT_HOSTS = ['stripe.com', 'checkout.stripe.com', 'paypal.com', 'adyen.com', 'squareup.com'];

function isPaymentHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return PAYMENT_HOSTS.some((p) => h === p || h.endsWith('.' + p));
}

/**
 * Network-layer safety (spec §14).
 * - read_only: non-GET/HEAD requests to the target origin are aborted unless the pathname starts with an
 *   auth-allowlist prefix. read_only constrains the TARGET origin only; non-GET to third-party origins
 *   (analytics beacons etc.) is allowed in both modes.
 * - Document requests (navigations, iframes) to origins other than the target / extraHosts are aborted.
 * - Payment hosts are always aborted.
 * Every abort is recorded as a `policy` signal in the returned `blocked` array.
 */
export async function installPolicy(context: BrowserContext, opts: PolicyOptions): Promise<{ blocked: Signal[] }> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const blocked: Signal[] = [];
  const target = new URL(opts.origin);
  const extra = new Set((opts.extraHosts ?? []).map((h) => h.toLowerCase()));

  await context.route('**/*', async (route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.continue();
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();

    const method = req.method().toUpperCase();
    const block = async () => {
      blocked.push({ kind: 'policy', method, url: req.url(), tMs: now() - t0 });
      await route.abort('blockedbyclient');
    };

    if (isPaymentHost(url.hostname)) return block();

    const sameOrigin = url.origin === target.origin;
    if (req.resourceType() === 'document' && !sameOrigin) {
      const allowed = extra.has(url.hostname.toLowerCase()) || extra.has(url.host.toLowerCase());
      if (!allowed) return block();
    }

    if (opts.allowedActions === 'read_only' && sameOrigin && method !== 'GET' && method !== 'HEAD') {
      const authOk = opts.authAllowlist.some((p) => url.pathname.startsWith(p));
      if (!authOk) return block();
    }
    return route.continue();
  });

  return { blocked };
}

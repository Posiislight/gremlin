import type { Page, Request } from 'playwright';

export type SettleOptions = { quietMs?: number; capMs?: number };

// Idempotent; counters live on window so they are re-created after a navigation.
const PROBE = `(() => {
  const w = window;
  if (!w.__gremlinSettle) {
    const s = { count: 0 };
    w.__gremlinSettle = s;
    const start = () => {
      new MutationObserver(() => { s.count++; }).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
    };
    if (document.documentElement) start();
  }
  return w.__gremlinSettle.count;
})()`;

type Tracker = { inflight: Map<Request, number>; lastActivity: number };
const trackers = new WeakMap<Page, Tracker>();

/**
 * Attach (once per page) request tracking, so requests started by an action just before settle() runs are
 * still counted. execute() calls this before acting; settle() calls it too.
 */
export function trackRequests(page: Page): Tracker {
  let t = trackers.get(page);
  if (t) return t;
  const tracker: Tracker = { inflight: new Map(), lastActivity: Date.now() };
  page.on('request', (r) => {
    // A main-frame navigation request starts a NEW document: requests of the old one are cancelled and may
    // never emit finished/failed. (Same-document pushState/hash changes issue no navigation request.)
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) tracker.inflight.clear();
    tracker.inflight.set(r, Date.now());
    tracker.lastActivity = Date.now();
  });
  const done = (r: Request) => {
    tracker.inflight.delete(r);
    tracker.lastActivity = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  trackers.set(page, tracker);
  t = tracker;
  return t;
}

/** Wait until no requests are in flight and the DOM has been mutation-free for quietMs, or capMs elapses. */
export async function settle(page: Page, opts: SettleOptions = {}): Promise<{ capped: boolean; ms: number }> {
  const quietMs = opts.quietMs ?? 500;
  const capMs = opts.capMs ?? 4000;
  const start = Date.now();
  const tracker = trackRequests(page);
  let lastCount = -1;
  for (;;) {
    // Prune entries older than capMs + quietMs: they are stale, not in flight.
    for (const [r, at] of tracker.inflight) if (Date.now() - at > capMs + quietMs) tracker.inflight.delete(r);
    let domActivity = false;
    try {
      const count = (await page.evaluate(PROBE)) as number;
      if (count !== lastCount) {
        domActivity = lastCount !== -1 || count > 0;
        lastCount = count;
      }
    } catch {
      // Context destroyed mid-navigation: treat as activity and re-inject next poll.
      domActivity = true;
      lastCount = -1;
    }
    if (domActivity) tracker.lastActivity = Date.now();
    const now = Date.now();
    const quietSince = Math.max(start, tracker.lastActivity);
    if (tracker.inflight.size === 0 && now - quietSince >= quietMs) return { capped: false, ms: now - start };
    if (now - start >= capMs) return { capped: true, ms: now - start };
    await new Promise((r) => setTimeout(r, 25));
  }
}

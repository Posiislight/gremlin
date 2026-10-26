import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { Decision } from './decide.js';

export type PausedRequest = {
  url: string;
  method: string;
  resourceType: string;
  isRedirect: boolean;
  frameId: string | undefined;
};

/** One context's view of the shared interceptor. */
export type InterceptClient = {
  contextId: string;
  context: BrowserContext;
  /** Pure verdict for a request (must not throw; a rule failure is a deny). */
  decide(req: PausedRequest): Decision;
  /** Record a denial as a policy signal. `reason` is kept in the handle's details. */
  record(req: PausedRequest, reason: string): void;
};

type Paused = {
  requestId: string;
  frameId?: string;
  resourceType: string;
  redirectedRequestId?: string;
  request: { url: string; method: string };
};

type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
type Attribution = { kind: 'client'; client: InterceptClient } | { kind: 'other' } | { kind: 'unknown' };

const TOMBSTONE_MS = 60_000;
const PRUNE_EVERY_MS = 15_000;
const MAX_FRAMES = 20_000;

/**
 * One browser-level CDP `Fetch` interceptor per Browser, shared by every context that installed a policy.
 *
 * Why browser level (not per-page sessions): Fetch.enable on the browser target pauses EVERY request from every
 * renderer - including each redirect hop (the browser then performs request and redirect natively), popups from
 * their very first request, out-of-process iframes and dedicated workers. Playwright's per-page CDPSession
 * cannot see a popup before its 'page' event (the first navigation is already in flight) and cannot address
 * auto-attached child sessions.
 *
 * Attribution: frameId -> target -> browserContextId (workers report their owner frame). OOPIF frames, which
 * are not browser targets, are resolved through Page.getFrameTree of the pages of ALL contexts of the browser
 * (so a frame of an unrelated no-policy context is recognised as "another context", not as unknown).
 * An attribution has three outcomes: a policy client, "another context" (continued untouched: other contexts
 * are never affected), or unknown.
 *
 * Tombstones: when a target is destroyed its target -> context mapping is KEPT for TOMBSTONE_MS (or until its
 * context is unregistered), because pages issue requests while closing (sendBeacon / keepalive fetch in
 * `pagehide`) after the destroyed event. A timer prunes tombstones; it only runs while a client is registered
 * and is unref'd and cleared on the last unregister.
 *
 * Unknown requests FAIL CLOSED: if any registered policy would deny the request (payment host, foreign
 * navigation, read_only write, ...) it is failed and recorded with reason `unattributed: ...` on those clients;
 * an unknown request no policy would deny is continued (it cannot violate any policy). Attribution errors are
 * treated as unknown.
 *
 * Every paused request is released exactly once (continue or fail); release errors (target closed, stale id)
 * are ignored.
 */
export class BrowserInterceptor {
  private static readonly instances = new WeakMap<Browser, Promise<BrowserInterceptor>>();

  static for(browser: Browser): Promise<BrowserInterceptor> {
    let p = BrowserInterceptor.instances.get(browser);
    if (!p) {
      p = (async () => {
        const session = await browser.newBrowserCDPSession();
        const i = new BrowserInterceptor(browser, session);
        i.listen();
        return i;
      })();
      BrowserInterceptor.instances.set(browser, p);
    }
    return p;
  }

  private readonly clients = new Map<string, InterceptClient>();
  private readonly targetCtx = new Map<string, string>();
  private readonly destroyedAt = new Map<string, number>();
  private readonly frameCtx = new Map<string, string>();
  private readonly pageSessions = new WeakMap<Page, CDPSession>();
  private pending = 0;
  private scanning: Promise<void> | null = null;
  private pruner: NodeJS.Timeout | null = null;

  private constructor(
    private readonly browser: Browser,
    private readonly session: CDPSession,
  ) {}

  private listen(): void {
    const s = this.session;
    const note = (e: { targetInfo: { targetId: string; browserContextId?: string } }) => {
      if (e.targetInfo.browserContextId) {
        this.targetCtx.set(e.targetInfo.targetId, e.targetInfo.browserContextId);
        this.destroyedAt.delete(e.targetInfo.targetId);
      }
    };
    s.on('Target.targetCreated', note);
    s.on('Target.targetInfoChanged', note);
    // Tombstone: keep the mapping (see class comment); only remember when it died.
    s.on('Target.targetDestroyed', (e: { targetId: string }) => {
      if (this.targetCtx.has(e.targetId)) this.destroyedAt.set(e.targetId, Date.now());
    });
    s.on('Fetch.requestPaused', (e: Paused) => void this.onPaused(e));
  }

  /** Fetch.enable/disable calls are serialised so a late register and an early unregister cannot interleave. */
  private op: Promise<void> = Promise.resolve();
  private enabled = false;
  private sync(): Promise<void> {
    this.op = this.op.then(async () => {
      const want = this.clients.size > 0;
      this.setPruner(want);
      if (want === this.enabled) return;
      this.enabled = want;
      if (want) {
        await this.session.send('Target.setDiscoverTargets', { discover: true });
        await this.session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      } else {
        await this.session.send('Fetch.disable');
      }
    });
    return this.op.catch(() => undefined);
  }

  private setPruner(on: boolean): void {
    if (on && !this.pruner) {
      this.pruner = setInterval(() => this.prune(), PRUNE_EVERY_MS);
      this.pruner.unref();
    } else if (!on && this.pruner) {
      clearInterval(this.pruner);
      this.pruner = null;
      this.prune(true);
    }
  }

  private prune(all = false): void {
    const now = Date.now();
    for (const [t, at] of this.destroyedAt) {
      if (all || now - at > TOMBSTONE_MS) {
        this.destroyedAt.delete(t);
        this.targetCtx.delete(t);
      }
    }
    while (this.frameCtx.size > MAX_FRAMES) this.frameCtx.delete(this.frameCtx.keys().next().value as string);
  }

  /** Requests currently held (paused and not yet released) for this browser. Diagnostic / tests. */
  paused(): number {
    return this.pending;
  }

  /** True while Fetch interception is switched on (some policy client is registered). */
  active(): boolean {
    return this.enabled;
  }

  /** Start judging the client's context. Resolves once Fetch interception is active. */
  async register(client: InterceptClient): Promise<void> {
    this.clients.set(client.contextId, client);
    await this.sync();
  }

  /** Stop judging a context; interception is switched off when no client is left (the session itself lives as long as the browser). */
  async unregister(contextId: string): Promise<void> {
    this.clients.delete(contextId);
    for (const [f, c] of this.frameCtx) if (c === contextId) this.frameCtx.delete(f);
    for (const [t, c] of this.targetCtx) {
      if (c === contextId && this.destroyedAt.has(t)) {
        this.destroyedAt.delete(t);
        this.targetCtx.delete(t);
      }
    }
    await this.sync();
  }

  private async onPaused(e: Paused): Promise<void> {
    this.pending++;
    let released = false;
    const release = async (block: boolean) => {
      if (released) return;
      released = true;
      try {
        if (block) await this.session.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
        else await this.session.send('Fetch.continueRequest', { requestId: e.requestId });
      } catch {
        /* target closed or stale interception id: nothing left to release */
      } finally {
        this.pending--;
      }
    };
    const req: PausedRequest = {
      url: e.request.url,
      method: e.request.method,
      resourceType: e.resourceType,
      isRedirect: e.redirectedRequestId !== undefined,
      frameId: e.frameId,
    };
    let block = false;
    try {
      let a: Attribution;
      try {
        a = await this.attribute(e.frameId);
      } catch {
        a = { kind: 'unknown' };
      }
      if (a.kind === 'client') {
        const d = a.client.decide(req);
        if (!d.allow) {
          a.client.record(req, d.reason);
          block = true;
        }
      } else if (a.kind === 'unknown') {
        for (const c of this.clients.values()) {
          const d = c.decide(req);
          if (!d.allow) {
            c.record(req, `unattributed: ${d.reason}`);
            block = true;
          }
        }
      }
    } catch {
      block = true; // anything unexpected while judging fails closed
    }
    await release(block);
  }

  private async attribute(frameId: string | undefined): Promise<Attribution> {
    if (!frameId) return { kind: 'unknown' };
    const lookup = () => this.frameCtx.get(frameId) ?? this.targetCtx.get(frameId);
    let cid = lookup();
    if (!cid) {
      await this.scanFrameTrees();
      cid = lookup();
    }
    if (!cid) return { kind: 'unknown' };
    const client = this.clients.get(cid);
    return client ? { kind: 'client', client } : { kind: 'other' };
  }

  private async sessionFor(page: Page): Promise<CDPSession> {
    let ps = this.pageSessions.get(page);
    if (!ps) {
      ps = await page.context().newCDPSession(page);
      this.pageSessions.set(page, ps);
    }
    return ps;
  }

  /** Frame ids (main frame, iframes incl. out-of-process ones) currently in a page's frame tree. */
  async frameIdsOf(page: Page): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const { frameTree } = (await (await this.sessionFor(page)).send('Page.getFrameTree')) as { frameTree: FrameTree };
      const walk = (n: FrameTree) => {
        ids.add(n.frame.id);
        n.childFrames?.forEach(walk);
      };
      walk(frameTree);
    } catch {
      /* page closed */
    }
    return ids;
  }

  /** Map every frame (incl. out-of-process iframes) of every page of the browser to its context. */
  private scanFrameTrees(): Promise<void> {
    this.scanning ??= (async () => {
      try {
        for (const context of this.browser.contexts()) {
          for (const page of context.pages()) {
            const ids = await this.frameIdsOf(page);
            // The main frame's id is its page target's id, which tells us the context.
            const cid = [...ids].map((id) => this.targetCtx.get(id)).find((c) => c !== undefined);
            if (cid) for (const id of ids) this.frameCtx.set(id, cid);
          }
        }
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }
}

/** Playwright exposes no public browserContextId; read it from a page target (a temporary blank page if there is none). */
export async function contextIdOf(context: BrowserContext): Promise<string> {
  let page = context.pages()[0];
  let temp = false;
  if (!page) {
    page = await context.newPage();
    temp = true;
  }
  try {
    const s = await context.newCDPSession(page);
    const { targetInfo } = (await s.send('Target.getTargetInfo')) as { targetInfo: { browserContextId?: string } };
    await s.detach().catch(() => undefined);
    if (!targetInfo.browserContextId) throw new Error('browserContextId unavailable (Chromium only)');
    return targetInfo.browserContextId;
  } finally {
    if (temp) await page.close().catch(() => undefined);
  }
}

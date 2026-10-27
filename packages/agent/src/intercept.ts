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
  /** Record a denial of a request KNOWN to come from this context as a policy signal. */
  record(req: PausedRequest, reason: string): void;
  /**
   * Note a request of unknown origin that was failed because this client's policy would deny it. It is NOT a
   * signal of this context (the request may belong to any context); kept for diagnostics only.
   */
  recordUnattributed?(req: PausedRequest, reason: string): void;
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
type TargetInfo = { targetId: string; type?: string; browserContextId?: string; openerId?: string };

/** A tracking session on one page: Page domain events map every frame of the page to its context. */
type Track = { session: CDPSession; targetId: string; cid: string; frames: Set<string>; closed: boolean };

const PRUNE_EVERY_MS = 15_000;
const MAX_FRAMES = 20_000;

/** Diagnostic sizes of the attribution maps (tests). */
export type InterceptStats = {
  clients: number;
  trackedPages: number;
  targets: number;
  destroyedTargets: number;
  frames: number;
  goneFrames: number;
  openers: number;
  paused: number;
};

/**
 * One browser-level CDP `Fetch` interceptor per Browser, shared by every context that installed a policy.
 *
 * Why browser level (not per-page sessions): Fetch.enable on the browser target pauses EVERY request from every
 * renderer - including each redirect hop (the browser then performs request and redirect natively), popups from
 * their very first request, out-of-process iframes and dedicated workers. Playwright's per-page CDPSession
 * cannot see a popup before its 'page' event (the first navigation is already in flight) and cannot address
 * auto-attached child sessions.
 *
 * Attribution (frameId -> context), tracked EAGERLY while any client is registered:
 * - targets (pages, popups, out-of-process iframes; their main frame id is the target id) from browser-level
 *   target discovery: targetId -> browserContextId, and the opener of popups;
 * - in-process iframes: every page of EVERY context of the browser (including contexts without a policy) gets
 *   a tracking CDP session with `Page.enable`; `Page.frameAttached` / `Page.frameNavigated` (and an initial
 *   `Page.getFrameTree`) record frame -> context before the frame can issue its first request. New contexts are
 *   discovered from target creation, new pages from the context's 'page' event. Sessions are detached when the
 *   page closes and when the last client unregisters.
 * - as a last resort for a frame seen by no event yet, the frame trees of all pages are scanned.
 *
 * Tombstones: a destroyed target, a detached frame and the frames of a closed page KEEP their mapping for
 * `tombstoneMs` (60 s; or until their context is unregistered), because pages issue requests while closing
 * (sendBeacon / keepalive fetch in `pagehide`) after they are gone. A timer prunes tombstones; it only runs while
 * a client is registered and is unref'd and cleared on the last unregister.
 *
 * An attribution has three outcomes:
 * - a policy client: its policy decides; a denial is recorded in that client's `blocked` list;
 * - another context (no policy): continued untouched - other contexts are never affected;
 * - unknown (no frameId - e.g. shared workers -, a frame no event, tombstone or scan maps, or an attribution
 *   error). Rule: it is FAILED if at least one registered policy would deny it, otherwise continued. A request of
 *   unknown origin is never recorded as a signal of any context (it may belong to an unrelated one); each client
 *   whose policy would deny it notes it in its `unattributed` list (diagnostics) instead.
 * Safety invariant: a request KNOWN to come from a read_only context is never allowed to write (it is judged by
 * that context's policy); a request whose context cannot be determined may be failed only if some policy would
 * deny it. With eager tracking, unknowns are limited to sources without a frame (shared workers, browser
 * requests) and frames nested inside out-of-process iframes that are created and used before any scan.
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

  /** How long a destroyed target / gone frame stays attributable. Tests may lower it. */
  tombstoneMs = 60_000;

  private readonly browser: Browser;
  private readonly session: CDPSession;
  private readonly clients = new Map<string, InterceptClient>();
  private readonly targetCtx = new Map<string, string>();
  private readonly destroyedAt = new Map<string, number>();
  private readonly opener = new Map<string, string>(); // popup target id -> opener target id
  private readonly openedAt = new Map<string, number>(); // popup target id -> when it was created
  private readonly frameCtx = new Map<string, string>(); // frame id -> context id (in-process frames)
  private readonly framePage = new Map<string, string>(); // frame id -> page target id
  private readonly frameGoneAt = new Map<string, number>();
  private readonly tracked = new Map<Page, Track>();
  private readonly tracking$ = new Map<Page, Promise<Track | null>>();
  private readonly hooked = new Map<BrowserContext, (p: Page) => void>();
  private readonly extraSessions = new WeakMap<Page, CDPSession>();
  private tracking = false;
  private pending = 0;
  private scanning: Promise<void> | null = null;
  private pruner: NodeJS.Timeout | null = null;

  private constructor(browser: Browser, session: CDPSession) {
    this.browser = browser;
    this.session = session;
  }

  private listen(): void {
    const s = this.session;
    const note = (e: { targetInfo: TargetInfo }) => {
      const t = e.targetInfo;
      if (t.browserContextId) {
        this.targetCtx.set(t.targetId, t.browserContextId);
        this.destroyedAt.delete(t.targetId);
      }
      if (t.openerId && !this.opener.has(t.targetId)) {
        this.opener.set(t.targetId, t.openerId);
        this.openedAt.set(t.targetId, Date.now());
      }
    };
    s.on('Target.targetCreated', (e: { targetInfo: TargetInfo }) => {
      note(e);
      // A new page may belong to a context created since the last discovery: hook it (eager frame tracking).
      if (this.tracking && e.targetInfo.type === 'page') void this.discover().catch(() => undefined);
    });
    s.on('Target.targetInfoChanged', note);
    // Tombstone: keep the mapping (see class comment); only remember when it died.
    s.on('Target.targetDestroyed', (e: { targetId: string }) => {
      if (this.targetCtx.has(e.targetId)) this.destroyedAt.set(e.targetId, Date.now());
      else this.dropOpener(e.targetId);
    });
    s.on('Fetch.requestPaused', (e: Paused) => void this.onPaused(e));
  }

  /** Fetch.enable/disable and tracking start/stop are serialised so a late register and an early unregister cannot interleave. */
  private op: Promise<void> = Promise.resolve();
  private enabled = false;
  private sync(): Promise<void> {
    this.op = this.op.then(async () => {
      const want = this.clients.size > 0;
      this.setPruner(want);
      if (want && !this.tracking) {
        this.tracking = true;
        await this.session.send('Target.setDiscoverTargets', { discover: true });
        await this.discover();
      } else if (!want && this.tracking) {
        this.stopTracking();
      }
      if (want === this.enabled) return;
      this.enabled = want;
      if (want) await this.session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      else await this.session.send('Fetch.disable');
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

  /** Drop tombstones older than tombstoneMs (all of them with `all`). Public for tests. */
  prune(all = false): void {
    const now = Date.now();
    for (const [t, at] of this.destroyedAt) {
      if (all || now - at > this.tombstoneMs) {
        this.destroyedAt.delete(t);
        this.targetCtx.delete(t);
        this.dropOpener(t);
      }
    }
    for (const [f, at] of this.frameGoneAt) if (all || now - at > this.tombstoneMs) this.forgetFrame(f);
    while (this.frameCtx.size > MAX_FRAMES) this.forgetFrame(this.frameCtx.keys().next().value as string);
  }

  private dropOpener(t: string): void {
    this.opener.delete(t);
    this.openedAt.delete(t);
  }

  /** Number of popup targets `page` opened at or after `sinceMs` (Date.now() clock), closed ones included. */
  async popupsOpenedBy(page: Page, sinceMs: number): Promise<number> {
    let root = this.tracked.get(page)?.targetId;
    if (!root) {
      try {
        const s = await this.sessionFor(page);
        root = ((await s.send('Target.getTargetInfo')) as { targetInfo: TargetInfo }).targetInfo.targetId;
      } catch {
        return 0;
      }
    }
    let n = 0;
    for (const [t, o] of this.opener) if (o === root && (this.openedAt.get(t) ?? 0) >= sinceMs) n++;
    return n;
  }

  private forgetFrame(f: string): void {
    this.frameCtx.delete(f);
    this.framePage.delete(f);
    this.frameGoneAt.delete(f);
  }

  /** Requests currently held (paused and not yet released) for this browser. Diagnostic / tests. */
  paused(): number {
    return this.pending;
  }

  /** True while Fetch interception is switched on (some policy client is registered). */
  active(): boolean {
    return this.enabled;
  }

  /** The context id a frame (or target) is currently attributed to, without scanning. Diagnostic / tests. */
  contextOfFrame(frameId: string): string | undefined {
    return this.frameCtx.get(frameId) ?? this.targetCtx.get(frameId);
  }

  stats(): InterceptStats {
    return {
      clients: this.clients.size,
      trackedPages: this.tracked.size,
      targets: this.targetCtx.size,
      destroyedTargets: this.destroyedAt.size,
      frames: this.frameCtx.size,
      goneFrames: this.frameGoneAt.size,
      openers: this.opener.size,
      paused: this.pending,
    };
  }

  /** Start judging the client's context. Resolves once Fetch interception (and frame tracking) is active. */
  async register(client: InterceptClient): Promise<void> {
    this.clients.set(client.contextId, client);
    await this.sync();
  }

  /** Stop judging a context; interception is switched off when no client is left (the session itself lives as long as the browser). */
  async unregister(contextId: string): Promise<void> {
    this.clients.delete(contextId);
    for (const [f, c] of this.frameCtx) if (c === contextId && this.frameGoneAt.has(f)) this.forgetFrame(f);
    for (const [t, c] of this.targetCtx) {
      if (c === contextId && this.destroyedAt.has(t)) {
        this.destroyedAt.delete(t);
        this.targetCtx.delete(t);
        this.dropOpener(t);
      }
    }
    await this.sync();
  }

  // ---- eager frame tracking -------------------------------------------------------------------------------

  /** Hook every context of the browser (new pages) and track all their existing pages. */
  private async discover(): Promise<void> {
    if (!this.tracking) return;
    const jobs: Promise<unknown>[] = [];
    for (const context of this.browser.contexts()) {
      if (!this.hooked.has(context)) {
        const onPage = (p: Page) => void this.track(p);
        this.hooked.set(context, onPage);
        context.on('page', onPage);
        context.once('close', () => {
          context.off('page', onPage);
          this.hooked.delete(context);
        });
      }
      for (const page of context.pages()) jobs.push(this.track(page));
    }
    await Promise.all(jobs);
  }

  private stopTracking(): void {
    this.tracking = false;
    for (const [context, onPage] of this.hooked) context.off('page', onPage);
    this.hooked.clear();
    for (const t of this.tracked.values()) {
      t.closed = true;
      void t.session.detach().catch(() => undefined);
    }
    this.tracked.clear();
    this.tracking$.clear();
    this.frameCtx.clear();
    this.framePage.clear();
    this.frameGoneAt.clear();
  }

  private noteFrame(t: Track, frameId: string): void {
    t.frames.add(frameId);
    if (!t.cid || t.closed) return;
    this.frameCtx.set(frameId, t.cid);
    this.framePage.set(frameId, t.targetId);
    this.frameGoneAt.delete(frameId);
  }

  private frameGone(frameId: string): void {
    if (this.frameCtx.has(frameId) && !this.frameGoneAt.has(frameId)) this.frameGoneAt.set(frameId, Date.now());
  }

  /** Give a page a tracking session (once). Resolves when its current frames are mapped. */
  private track(page: Page): Promise<Track | null> {
    let p = this.tracking$.get(page);
    if (p) return p;
    p = (async () => {
      if (!this.tracking || page.isClosed()) return null;
      let session: CDPSession;
      try {
        session = await page.context().newCDPSession(page);
      } catch {
        return null; // page closed
      }
      const t: Track = { session, targetId: '', cid: '', frames: new Set(), closed: false };
      const untrack = () => {
        if (t.closed) return;
        t.closed = true;
        if (this.tracked.get(page) === t) this.tracked.delete(page);
        this.tracking$.delete(page);
        for (const f of t.frames) this.frameGone(f);
        void session.detach().catch(() => undefined);
      };
      session.on('Page.frameAttached', (e: { frameId: string }) => this.noteFrame(t, e.frameId));
      session.on('Page.frameNavigated', (e: { frame: { id: string } }) => this.noteFrame(t, e.frame.id));
      session.on('Page.frameDetached', (e: { frameId: string }) => this.frameGone(e.frameId));
      page.once('close', untrack);
      try {
        const { targetInfo } = (await session.send('Target.getTargetInfo')) as { targetInfo: TargetInfo };
        if (!targetInfo.browserContextId) throw new Error('no browserContextId');
        t.targetId = targetInfo.targetId;
        t.cid = targetInfo.browserContextId;
        for (const f of [targetInfo.targetId, ...t.frames]) this.noteFrame(t, f);
        if (!this.tracking || t.closed) {
          untrack();
          return null;
        }
        this.tracked.set(page, t);
        await session.send('Page.enable');
        this.addTree(t, ((await session.send('Page.getFrameTree')) as { frameTree: FrameTree }).frameTree);
        return t;
      } catch {
        untrack();
        return null;
      }
    })();
    this.tracking$.set(page, p);
    return p;
  }

  private addTree(t: Track, tree: FrameTree): void {
    this.noteFrame(t, tree.frame.id);
    tree.childFrames?.forEach((c) => this.addTree(t, c));
  }

  // ---- judging --------------------------------------------------------------------------------------------

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
        // Fail only if some policy would deny it; never record it as a signal of a context (see class comment).
        for (const c of this.clients.values()) {
          const d = c.decide(req);
          if (!d.allow) {
            block = true;
            try {
              c.recordUnattributed?.(req, `unattributed: ${d.reason}`);
            } catch {
              /* diagnostics only */
            }
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
    const t = this.tracked.get(page);
    if (t && !t.closed) return t.session;
    let ps = this.extraSessions.get(page);
    if (!ps) {
      ps = await page.context().newCDPSession(page);
      this.extraSessions.set(page, ps);
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

  /**
   * A predicate telling whether a frame id belongs to `page`: its current frame tree, any frame ever tracked for
   * it (also frames removed since), and the frames of popups it opened (transitively, via the target opener).
   */
  async ownedBy(page: Page): Promise<(frameId: string) => boolean> {
    const ids = await this.frameIdsOf(page);
    let root = this.tracked.get(page)?.targetId;
    if (!root) {
      for (const id of ids) if (this.targetCtx.has(id)) root = id; // only the main frame id is a page target id
    }
    const pages = new Set<string>(root ? [root] : []);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [t, o] of this.opener) {
        if (pages.has(o) && !pages.has(t)) {
          pages.add(t);
          grew = true;
        }
      }
    }
    return (f) => ids.has(f) || pages.has(f) || pages.has(this.framePage.get(f) ?? '');
  }

  /** Map every frame of every page of the browser to its context (fallback for frames no event mapped yet). */
  private scanFrameTrees(): Promise<void> {
    this.scanning ??= (async () => {
      try {
        const jobs: Promise<unknown>[] = [];
        for (const context of this.browser.contexts()) {
          for (const page of context.pages()) {
            jobs.push(
              (async () => {
                const t = this.tracking ? await this.track(page) : null;
                if (t && !t.closed) {
                  try {
                    this.addTree(t, ((await t.session.send('Page.getFrameTree')) as { frameTree: FrameTree }).frameTree);
                  } catch {
                    /* page closed */
                  }
                  return;
                }
                const ids = await this.frameIdsOf(page);
                // The main frame's id is its page target's id, which tells us the context.
                const cid = [...ids].map((id) => this.targetCtx.get(id)).find((c) => c !== undefined);
                if (cid) for (const id of ids) this.frameCtx.set(id, cid);
              })(),
            );
          }
        }
        await Promise.all(jobs);
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

import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';

export type PausedRequest = {
  url: string;
  method: string;
  resourceType: string;
  isRedirect: boolean;
  frameId: string | undefined;
};

/** One context's view of the shared interceptor. `allow` must be synchronous and side-effect free apart from recording. */
export type InterceptClient = {
  contextId: string;
  context: BrowserContext;
  allow(req: PausedRequest): boolean;
};

type Paused = {
  requestId: string;
  frameId?: string;
  resourceType: string;
  redirectedRequestId?: string;
  request: { url: string; method: string };
};

type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };

/**
 * One browser-level CDP `Fetch` interceptor per Browser, shared by every context that installed a policy.
 *
 * Why browser level (not per-page sessions): Fetch.enable on the browser target pauses EVERY request from every
 * renderer - including each redirect hop (the browser then performs request and redirect natively), popups from
 * their very first request, out-of-process iframes and dedicated workers. Playwright's per-page CDPSession
 * cannot see a popup before its 'page' event (the first navigation is already in flight) and cannot address
 * auto-attached child sessions. Requests are attributed to a context by frameId -> target -> browserContextId
 * (workers report their owner frame); OOPIF frames, which are not browser targets, are resolved through
 * Page.getFrameTree of the registered contexts' pages. Requests of contexts without a policy, and requests that
 * cannot be attributed (e.g. shared/service workers - service workers are blocked by createAgentContext), are
 * continued untouched, so other contexts are never affected.
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
        const i = new BrowserInterceptor(session);
        i.listen();
        return i;
      })();
      BrowserInterceptor.instances.set(browser, p);
    }
    return p;
  }

  private readonly clients = new Map<string, InterceptClient>();
  private readonly targetCtx = new Map<string, string>();
  private readonly frameCtx = new Map<string, string>();
  private readonly pageSessions = new WeakMap<Page, CDPSession>();
  private pending = 0;
  private scanning: Promise<void> | null = null;

  private constructor(private readonly session: CDPSession) {}

  private listen(): void {
    const s = this.session;
    const note = (e: { targetInfo: { targetId: string; browserContextId?: string } }) => {
      if (e.targetInfo.browserContextId) this.targetCtx.set(e.targetInfo.targetId, e.targetInfo.browserContextId);
    };
    s.on('Target.targetCreated', note);
    s.on('Target.targetInfoChanged', note);
    s.on('Target.targetDestroyed', (e: { targetId: string }) => {
      this.targetCtx.delete(e.targetId);
      this.frameCtx.delete(e.targetId);
    });
    s.on('Fetch.requestPaused', (e: Paused) => void this.onPaused(e));
  }

  /** Fetch.enable/disable calls are serialised so a late register and an early unregister cannot interleave. */
  private op: Promise<void> = Promise.resolve();
  private enabled = false;
  private sync(): Promise<void> {
    this.op = this.op.then(async () => {
      const want = this.clients.size > 0;
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

  /** Requests currently held (paused and not yet released) for this browser. Diagnostic / tests. */
  paused(): number {
    return this.pending;
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
    let block = false;
    try {
      const client = await this.clientFor(e.frameId);
      if (client) {
        block = !client.allow({
          url: e.request.url,
          method: e.request.method,
          resourceType: e.resourceType,
          isRedirect: e.redirectedRequestId !== undefined,
          frameId: e.frameId,
        });
      }
    } catch {
      block = false; // attribution failure only (decision errors are handled inside allow()); never hang the page
    }
    await release(block);
  }

  private async clientFor(frameId: string | undefined): Promise<InterceptClient | undefined> {
    if (!frameId) return undefined;
    let cid = this.frameCtx.get(frameId) ?? this.targetCtx.get(frameId);
    if (!cid) {
      await this.scanFrameTrees();
      cid = this.frameCtx.get(frameId);
    }
    return cid ? this.clients.get(cid) : undefined;
  }

  /** Map every frame (incl. out-of-process iframes) of the registered contexts' pages to its context. */
  private scanFrameTrees(): Promise<void> {
    this.scanning ??= (async () => {
      try {
        for (const client of this.clients.values()) {
          for (const page of client.context.pages()) {
            try {
              let ps = this.pageSessions.get(page);
              if (!ps) {
                ps = await client.context.newCDPSession(page);
                this.pageSessions.set(page, ps);
              }
              const { frameTree } = (await ps.send('Page.getFrameTree')) as { frameTree: FrameTree };
              const walk = (n: FrameTree) => {
                this.frameCtx.set(n.frame.id, client.contextId);
                n.childFrames?.forEach(walk);
              };
              walk(frameTree);
            } catch {
              /* page closed meanwhile */
            }
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

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { BrowserInterceptor, type InterceptClient, type PausedRequest } from '../src/intercept.js';
import { decideRequest, type PolicyOptions } from '../src/decide.js';

/** A fake browser-level CDP session: records commands, lets the test emit events. */
class FakeSession extends EventEmitter {
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return {};
  }
  released(requestId: string): string[] {
    return this.sent.filter((s) => s.params?.requestId === requestId).map((s) => s.method);
  }
}

async function fakeInterceptor() {
  const session = new FakeSession();
  // A browser without contexts: no frame can be attributed, every request with a frame id is "unknown".
  const browser = { newBrowserCDPSession: async () => session, contexts: () => [] } as unknown as Browser;
  const ic = await BrowserInterceptor.for(browser);
  return { ic, session };
}

function client(contextId: string, mode: PolicyOptions['allowedActions']) {
  const recorded: string[] = [];
  const unattributed: string[] = [];
  const opts: PolicyOptions = { origin: 'http://127.0.0.1:4000', allowedActions: mode, authAllowlist: [] };
  const c: InterceptClient = {
    contextId,
    context: {} as BrowserContext,
    decide: (req: PausedRequest) => decideRequest(req, opts),
    record: (_req, reason) => recorded.push(reason),
    recordUnattributed: (_req, reason) => unattributed.push(reason),
  };
  return { c, recorded, unattributed };
}

const paused = (requestId: string, method: string, url: string, frameId?: string) => ({
  requestId,
  frameId,
  resourceType: 'Fetch',
  request: { url, method },
});

async function settleUntilReleased(session: FakeSession, ic: BrowserInterceptor, requestId: string) {
  await expect.poll(() => session.released(requestId).length).toBe(1);
  expect(ic.paused()).toBe(0);
  return session.released(requestId);
}

describe('unknown-origin requests (faked Fetch.requestPaused)', () => {
  it('no policy would deny it (no read_only client): continued, nothing recorded', async () => {
    const { ic, session } = await fakeInterceptor();
    const full = client('ctx-full', 'full');
    await ic.register(full.c);
    session.emit('Fetch.requestPaused', paused('r1', 'POST', 'http://127.0.0.1:4000/api/hit'));
    session.emit('Fetch.requestPaused', paused('r2', 'POST', 'http://127.0.0.1:4000/api/hit', 'frame-nobody-knows'));
    expect(await settleUntilReleased(session, ic, 'r1')).toEqual(['Fetch.continueRequest']);
    expect(await settleUntilReleased(session, ic, 'r2')).toEqual(['Fetch.continueRequest']);
    expect(full.recorded).toEqual([]);
    expect(full.unattributed).toEqual([]);
    await ic.unregister('ctx-full');
  });

  it('a policy would deny it: failed, noted in unattributed[] of that policy only, never as a signal', async () => {
    const { ic, session } = await fakeInterceptor();
    const ro = client('ctx-ro', 'read_only');
    const full = client('ctx-full', 'full');
    await ic.register(ro.c);
    await ic.register(full.c);
    session.emit('Fetch.requestPaused', paused('r1', 'POST', 'http://127.0.0.1:4000/api/hit')); // no frame id
    session.emit('Fetch.requestPaused', paused('r2', 'POST', 'http://127.0.0.1:4000/api/hit', 'frame-nobody-knows'));
    for (const id of ['r1', 'r2']) {
      expect(await settleUntilReleased(session, ic, id)).toEqual(['Fetch.failRequest']);
      expect(session.sent.find((s) => s.params?.requestId === id)!.params).toMatchObject({ errorReason: 'BlockedByClient' });
    }
    expect(ro.recorded).toEqual([]); // not in blocked / count()
    expect(ro.unattributed).toHaveLength(2);
    for (const r of ro.unattributed) expect(r).toMatch(/^unattributed: /);
    expect(full.recorded).toEqual([]);
    expect(full.unattributed).toEqual([]);
    await ic.unregister('ctx-ro');
    await ic.unregister('ctx-full');
  });

  it('a read_only client exists but its policy would not deny it (a GET): continued', async () => {
    const { ic, session } = await fakeInterceptor();
    const ro = client('ctx-ro', 'read_only');
    await ic.register(ro.c);
    session.emit('Fetch.requestPaused', paused('r1', 'GET', 'http://127.0.0.1:4000/api/ok', 'frame-nobody-knows'));
    expect(await settleUntilReleased(session, ic, 'r1')).toEqual(['Fetch.continueRequest']);
    expect(ro.recorded).toEqual([]);
    expect(ro.unattributed).toEqual([]);
    await ic.unregister('ctx-ro');
  });

  it('a closed context keeps its policy for late requests (grace period), then it is dropped', async () => {
    const { ic, session } = await fakeInterceptor();
    const ro = client('ctx-ro', 'read_only');
    await ic.register(ro.c);
    session.emit('Target.targetCreated', { targetInfo: { targetId: 'T1', type: 'page', browserContextId: 'ctx-ro' } });
    session.emit('Target.targetDestroyed', { targetId: 'T1' });
    await ic.retire('ctx-ro'); // the context closed
    expect(ic.active()).toBe(true);
    // a keepalive write of the closed page, paused late: still judged by (and recorded on) its own policy
    session.emit('Fetch.requestPaused', paused('r1', 'POST', 'http://127.0.0.1:4000/api/hit', 'T1'));
    expect(await settleUntilReleased(session, ic, 'r1')).toEqual(['Fetch.failRequest']);
    expect(ro.recorded).toHaveLength(1);
    expect(ro.unattributed).toEqual([]);
    ic.tombstoneMs = 0;
    await new Promise((r) => setTimeout(r, 5));
    ic.prune();
    await expect.poll(() => ic.active()).toBe(false);
    expect(ic.stats().retiredClients).toBe(0);
  });

  it('a payment host of unknown origin is failed under any policy', async () => {
    const { ic, session } = await fakeInterceptor();
    const full = client('ctx-full', 'full');
    await ic.register(full.c);
    session.emit('Fetch.requestPaused', paused('r1', 'GET', 'https://checkout.stripe.com/pay'));
    expect(await settleUntilReleased(session, ic, 'r1')).toEqual(['Fetch.failRequest']);
    expect(full.recorded).toEqual([]);
    expect(full.unattributed).toHaveLength(1);
    await ic.unregister('ctx-full');
  });
});

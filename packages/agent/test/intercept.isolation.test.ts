import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { asHost, FOREIGN } from './hosts.js';
import { startFixtureServer } from './server.js';
import { createAgentContext } from '../src/context.js';
import { installPolicy, markServiceWorkersBlocked, type PolicyHandle } from '../src/policy.js';

type Srv = Awaited<ReturnType<typeof startFixtureServer>>;
type Kind = 'read_only' | 'full' | null;

let browser: Browser;
let server: Srv;
let foreignSrv: Srv;

beforeAll(async () => {
  server = await startFixtureServer();
  foreignSrv = await startFixtureServer();
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  await foreignSrv?.close();
});

const hitsOf = async () => ((await (await fetch(`${server.url}/api/hits`)).json()) as { hits: number }).hits;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const write = (page: Page) =>
  page.evaluate(`fetch('/api/hit', { method: 'POST', body: 'x' }).then(() => 'ok', () => 'blocked')`) as Promise<'ok' | 'blocked'>;

async function mk(kind: Kind, b: Browser = browser, origin = server.url) {
  const context = await b.newContext({ serviceWorkers: 'block' });
  markServiceWorkersBlocked(context);
  const policy: PolicyHandle | null = kind ? await installPolicy(context, { origin, allowedActions: kind, authAllowlist: [] }) : null;
  const page = await context.newPage();
  await page.goto(`${origin}/empty.html`);
  return { context, page, policy, kind };
}

/** Write once and report [outcome seen by the page, hits that reached the server]. */
async function probe(page: Page): Promise<[string, number]> {
  const before = await hitsOf();
  const r = await write(page);
  await sleep(100);
  return [r, (await hitsOf()) - before];
}

describe('one browser, four contexts', () => {
  it('(a) each context gets its own policy; dispose and close only affect their own context', async () => {
    const A = await mk('read_only');
    const B = await mk('read_only');
    const C = await mk(null);
    const D = await mk('full');
    expect(await probe(A.page)).toEqual(['blocked', 0]);
    expect(await probe(B.page)).toEqual(['blocked', 0]);
    expect(await probe(C.page)).toEqual(['ok', 1]);
    expect(await probe(D.page)).toEqual(['ok', 1]);
    expect(A.policy!.count()).toBe(1);
    expect(B.policy!.count()).toBe(1);
    expect(D.policy!.count()).toBe(0);

    await A.policy!.dispose();
    expect(await probe(A.page)).toEqual(['ok', 1]);
    expect(await probe(B.page)).toEqual(['blocked', 0]);
    expect(B.policy!.active()).toBe(true);

    await A.context.close();
    expect(await probe(B.page)).toEqual(['blocked', 0]);
    expect(await probe(C.page)).toEqual(['ok', 1]);
    await Promise.all([B.context.close(), C.context.close(), D.context.close()]);
  });
});

describe('writes issued while pages close', () => {
  const ARM = `addEventListener('pagehide', () => { navigator.sendBeacon('/api/hit', 'x'); fetch('/api/hit', { method: 'POST', body: 'x', keepalive: true }); });`;
  const modes = ['page.close()', 'page.close({runBeforeUnload})', 'popup closed by opener', 'context.close()', 'popup guard closes it'] as const;

  async function runMode(mode: (typeof modes)[number], kind: 'read_only' | 'full'): Promise<number> {
    const before = await hitsOf();
    let context: BrowserContext;
    let page: Page;
    if (mode === 'popup guard closes it') {
      const a = await createAgentContext(browser, { policy: { origin: server.url, allowedActions: kind, authAllowlist: [] } });
      context = a.context;
      page = a.page;
    } else {
      ({ context, page } = await mk(kind));
    }
    await context.addInitScript(ARM);
    await page.goto(`${server.url}/empty.html`); // loaded after the init script so this page is armed too
    if (mode === 'popup closed by opener' || mode === 'popup guard closes it') {
      await page.evaluate(`window.pp = window.open('/empty.html')`);
      if (mode === 'popup closed by opener') {
        const pop = await context.waitForEvent('page');
        await pop.waitForLoadState();
        await page.evaluate('window.pp.close()');
      } else {
        await sleep(300);
        await page.close();
      }
    } else if (mode === 'page.close()') await page.close();
    else if (mode === 'page.close({runBeforeUnload})') await page.close({ runBeforeUnload: true });
    else await context.close();
    await sleep(600);
    await context.close().catch(() => undefined);
    return (await hitsOf()) - before;
  }

  it('(b) read_only: no unload write reaches the server in any closing mode (5 runs each)', async () => {
    for (const mode of modes) {
      for (let i = 0; i < 5; i++) expect(await runMode(mode, 'read_only'), `${mode} #${i}`).toBe(0);
    }
  }, 120_000);

  it('(b) control: under a full policy the same unload writes ARE received (the test can see a leak)', async () => {
    let received = 0;
    for (let i = 0; i < 3; i++) received += await runMode('page.close()', 'full');
    expect(received).toBeGreaterThan(0);
  }, 30_000);
});

describe('dispose', () => {
  it('(c) turns interception off, leaves nothing paused, and browser.close() does not hang', async () => {
    const own = await launchBrowser();
    const { context, page, policy } = await mk('read_only', own);
    expect(policy!.active()).toBe(true);
    expect(await write(page)).toBe('blocked');
    await policy!.dispose();
    expect(policy!.active()).toBe(false);
    expect(policy!.paused()).toBe(0);
    expect(await write(page)).toBe('ok'); // no longer enforced
    await context.close();
    const closed = await Promise.race([own.close().then(() => 'closed'), sleep(15_000).then(() => 'hung')]);
    expect(closed).toBe('closed');
  }, 40_000);
});

describe('concurrency', () => {
  it('(d) six contexts created in parallel with mixed policies, one closed while the others write', async () => {
    const kinds: Kind[] = ['read_only', 'full', null];
    for (let round = 0; round < 5; round++) {
      const made = await Promise.all(Array.from({ length: 6 }, (_, i) => mk(kinds[i % 3]!)));
      const before = await hitsOf();
      const results = await Promise.all(
        made.map(async (m, i) => {
          if (i === 3) {
            await m.context.close(); // a read_only context goes away mid-flight
            return null;
          }
          return write(m.page);
        }),
      );
      await sleep(150);
      let expectedOk = 0;
      made.forEach((m, i) => {
        if (i === 3) return;
        const want = m.kind === 'read_only' ? 'blocked' : 'ok';
        expect(results[i], `round ${round} ctx ${i} (${m.kind})`).toBe(want);
        if (want === 'ok') expectedOk++;
      });
      expect((await hitsOf()) - before).toBe(expectedOk);
      await Promise.all(made.map((m) => m.context.close().catch(() => undefined)));
    }
  }, 60_000);

  it('(e) churn of unrelated no-policy contexts (with cross-site iframes) never causes a false block', async () => {
    const R = await mk('read_only');
    let stop = false;
    const reads = (async () => {
      while (!stop) await R.page.evaluate(`Promise.all(Array.from({ length: 5 }, () => fetch('/api/ok').then(r => r.status)))`);
    })();
    const frameUrl = asHost(foreignSrv.url, FOREIGN) + '/empty.html';
    for (let i = 0; i < 20; i++) {
      const U = await mk(null);
      await U.page.setContent(`<iframe src="${frameUrl}"></iframe><img src="${frameUrl}">`);
      await U.page.waitForLoadState('load');
      await U.page.evaluate(`fetch('/api/hit', { method: 'POST', body: 'x' }).catch(() => null)`); // a write: allowed in a no-policy context
      await U.context.close();
    }
    stop = true;
    await reads;
    expect(R.policy!.blocked).toHaveLength(0);
    await R.context.close();
  }, 120_000);
});

describe('unattributable requests fail closed', () => {
  it('a shared worker write in a read_only context never reaches the server', async () => {
    const R = await mk('read_only');
    const before = await hitsOf();
    await R.page.evaluate(`new SharedWorker('/shared.js')`);
    await sleep(800);
    expect((await hitsOf()) - before).toBe(0);
    expect(R.policy!.blocked.length).toBeGreaterThanOrEqual(1);
    expect(R.policy!.blocked[0]).toMatchObject({ kind: 'policy', method: 'POST' });
    await R.context.close();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { ReplayTimeline, Step, type Candidate } from '@gremlin/contract';
import { FsStorage } from '@gremlin/storage';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { charter, click, fakeLlm, finish, type ScriptItem } from './loopHarness.js';
import { runAgent, type AgentEvent, type RunAgentOpts } from '../src/loop.js';
import { NAVIGATOR_SYSTEM, navigatorTool } from '../src/prompts.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let work: string;
let runs = 0;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  work = await mkdtemp(join(tmpdir(), 'gremlin-loop-'));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

function opts(startPath: string, script: ScriptItem[], over: Partial<RunAgentOpts> = {}) {
  const llm = fakeLlm(script);
  const storage = new FsStorage(join(work, 'storage'));
  const events: AgentEvent[] = [];
  const runId = `r${++runs}`;
  const o: RunAgentOpts = {
    browser,
    baseUrl: server.url,
    charter: charter(startPath),
    llm,
    storage,
    runId,
    keyPrefix: `scans/s1/runs/${runId}`,
    secrets: {},
    allowedActions: 'read_only',
    onEvent: (e) => events.push(e),
    ...over,
  };
  return { o, llm, storage, events };
}

describe('prompts', () => {
  it('navigator tool is the Action schema named act; system prompt carries the fixed rules', () => {
    expect(navigatorTool.name).toBe('act');
    expect(navigatorTool.schema.safeParse({ type: 'click', ref: 'e1', intent: 'x' }).success).toBe(true);
    expect(NAVIGATOR_SYSTEM).toMatch(/one action/i);
    expect(NAVIGATOR_SYSTEM).toMatch(/expect/);
    expect(NAVIGATOR_SYSTEM).toMatch(/never invent/i);
    expect(NAVIGATOR_SYSTEM).toMatch(/placeholder/i);
    expect(NAVIGATOR_SYSTEM).toMatch(/ignore/i);
  });
});

describe('runAgent', () => {
  it('click -> expect -> click -> finish on cart.html: finished, 4 steps, 1 expectation with before/after', async () => {
    const { o, events, storage } = opts('/cart.html', [
      click('Add to cart'),
      { type: 'expect', statement: 'badge shows 1', intent: 'check badge' },
      click('Add to cart'),
      finish('badge works'),
    ]);
    const r = await runAgent(o);
    expect(r.status).toBe('finished');
    expect(r.steps.map((s) => s.action.type)).toEqual(['click', 'expect', 'click', 'finish']);
    expect(r.steps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    for (const s of r.steps) expect(Step.safeParse(s).success).toBe(true);
    expect(r.steps[0]!.outcome).toBe('ok');
    expect(r.steps[0]!.locator?.role?.name).toBe('Add to cart');
    expect(r.steps[1]!.expectation).toBe('badge shows 1');

    expect(r.expectations).toHaveLength(1);
    const ex = r.expectations[0]!;
    expect(ex.stepN).toBe(2);
    expect(ex.statement).toBe('badge shows 1');
    expect(ex.before.rendered).toContain('Cart (1)');
    expect(ex.after.rendered).toContain('Cart (2)');

    expect(r.tokens).toBe(4 * 110);
    // events: running, 4 steps, finished
    expect(events[0]).toEqual({ type: 'status', status: 'running' });
    expect(events.filter((e) => e.type === 'step')).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: 'status', status: 'finished' });
    // screenshots + timeline persisted
    for (const s of r.steps.slice(0, 3)) {
      expect(s.screenshotKey).toBeTruthy();
      expect(await storage.exists(s.screenshotKey!)).toBe(true);
    }
    const tl = ReplayTimeline.parse(JSON.parse((await storage.get(r.artifacts.timelineKey)).toString('utf8')));
    expect(tl.steps).toHaveLength(4);
    expect(await storage.exists(r.artifacts.traceKey)).toBe(true);
  });

  it('50 scripted clicks stop at the 40-step budget', async () => {
    const script = Array.from({ length: 50 }, () => click('Add to cart'));
    const { o } = opts('/cart.html', script);
    const r = await runAgent(o);
    expect(r.status).toBe('budget_steps');
    expect(r.steps).toHaveLength(40);
    expect(r.steps.every((s) => s.outcome === 'ok')).toBe(true);
  }, 300_000);

  it('3 clicks on an inert element -> stuck', async () => {
    const { o } = opts('/cart.html', [click('Inert widget'), click('Inert widget'), click('Inert widget'), click('Inert widget')]);
    const r = await runAgent(o);
    expect(r.status).toBe('stuck');
    expect(r.steps).toHaveLength(3);
    expect(r.steps.map((s) => s.outcome)).toEqual(['noop', 'noop', 'noop']);
  });

  it('token and time budgets', async () => {
    const t = opts('/cart.html', Array.from({ length: 10 }, () => click('Add to cart')), { budgets: { tokens: 250 } });
    const rt = await runAgent(t.o);
    expect(rt.status).toBe('budget_tokens');
    expect(rt.steps).toHaveLength(3);
    expect(rt.tokens).toBe(330);

    const m = opts('/cart.html', [click('Add to cart')], { budgets: { ms: 1 } });
    const rm2 = await runAgent(m.o);
    expect(rm2.status).toBe('budget_time');
    expect(rm2.steps).toHaveLength(0);
  });

  it('page text is fenced as untrusted data, and a forged fence marker stays inside the fence', async () => {
    const { o, llm } = opts('/loop-inject.html', [finish()]);
    await runAgent(o);
    const p = llm.prompts[0]!;
    const open = /<<<PAGE_CONTENT ([0-9a-f]+)>>>/.exec(p);
    expect(open).not.toBeNull();
    const close = `<<<END_PAGE_CONTENT ${open![1]}>>>`;
    const start = p.indexOf(open![0]);
    const end = p.indexOf(close);
    expect(end).toBeGreaterThan(start);
    expect(p.indexOf(close, end + 1)).toBe(-1);
    const inj = p.indexOf('IGNORE PREVIOUS INSTRUCTIONS');
    const forged = p.indexOf('END PAGE CONTENT>>>');
    expect(inj).toBeGreaterThan(start);
    expect(inj).toBeLessThan(end);
    expect(forged).toBeGreaterThan(start);
    expect(forged).toBeLessThan(end);
    expect(llm.systems[0]).toBe(NAVIGATOR_SYSTEM);
  });

  it('a click that navigates (immediately or a moment later) does not crash the run', async () => {
    const { o, llm } = opts('/loop-nav.html', [
      click('Go later'),
      (p) => (p.includes('Cart (0)') ? finish('arrived') : new Error(`not on cart page:\n${p}`)),
    ]);
    const r1 = await runAgent(o);
    expect(r1.status).toBe('finished');
    expect(r1.steps).toHaveLength(2);
    expect(r1.steps[0]!.outcome).not.toBe('model_error');
    expect(llm.prompts[1]).toContain('Cart (0)');

    const b = opts('/loop-nav.html', [click('Go to shop'), click('Add to cart'), finish()]);
    const r2 = await runAgent(b.o);
    expect(r2.status).toBe('finished');
    expect(r2.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok']);
  });

  it('oracle candidates surface via onEvent and are deduped across steps; report_bug becomes agent_report', async () => {
    const bug = {
      type: 'report_bug' as const,
      title: 'Broken widget logs an error',
      expected: 'no error',
      actual: 'console error',
      severityHint: 'P2' as const,
      intent: 'report',
    };
    const { o, events, llm } = opts('/loop-nav.html', [click('Broken widget'), click('Broken widget'), bug, bug, finish()]);
    const r = await runAgent(o);
    expect(r.status).toBe('finished');
    const evCands = events.filter((e): e is { type: 'candidate'; candidate: Candidate } => e.type === 'candidate').map((e) => e.candidate);
    expect(evCands.map((c) => c.oracle).sort()).toEqual(['agent_report', 'console']);
    expect(r.candidates).toEqual(evCands);
    const con = r.candidates.find((c) => c.oracle === 'console')!;
    expect(con.stepN).toBe(1);
    const rep = r.candidates.find((c) => c.oracle === 'agent_report')!;
    expect(rep.stepN).toBe(3);
    expect(rep.severity).toBe('P2');
    expect(rep.message).toBe('Broken widget logs an error');
    // both clicks carried their console signal on the step
    expect(r.steps[0]!.signals.some((s) => s.kind === 'console')).toBe(true);
    expect(r.steps[1]!.signals.some((s) => s.kind === 'console')).toBe(true);
    // the console text is shown to the model inside the fence on the next step
    const p = llm.prompts[1]!;
    const fenceAt = p.indexOf('<<<PAGE_CONTENT ');
    expect(fenceAt).toBeGreaterThan(-1);
    expect(p.indexOf('console.error: Widget failed to render')).toBeGreaterThan(fenceAt);
    expect(p.indexOf('console.error: Widget failed to render')).toBeLessThan(p.indexOf('<<<END_PAGE_CONTENT '));
  });

  it('suppressed signatures produce no candidate', async () => {
    const first = opts('/loop-nav.html', [click('Broken widget'), finish()]);
    const r1 = await runAgent(first.o);
    const sig = r1.candidates.find((c) => c.oracle === 'console')!.signature;
    const second = opts('/loop-nav.html', [click('Broken widget'), finish()], { suppressed: new Set([sig]) });
    const r2 = await runAgent(second.o);
    expect(r2.candidates.filter((c) => c.oracle === 'console')).toHaveLength(0);
  });
});

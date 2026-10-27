import { describe, expect, it } from 'vitest';
import type { Signal, Step } from '@gremlin/contract';
import type { Observation } from '../src/observe.js';
import { runOracles, signatureFor, type OracleInput } from '../src/oracles/index.js';

const ORIGIN = 'http://app.test:3000';

function obs(over: Partial<Observation> = {}): Observation {
  return {
    url: `${ORIGIN}/orders/12`,
    path: '/orders/:id',
    stateHash: 'h',
    title: 'Orders',
    interactables: [{ ref: 'e1', role: 'button', name: 'Go', disabled: false, inViewport: true }],
    text: 'Your orders are listed below on this page.',
    alerts: [],
    rendered: '',
    tokenEstimate: 0,
    ...over,
  };
}

const step: Step = {
  n: 3,
  action: { type: 'click', ref: 'e1', intent: 'go' },
  locator: null,
  intent: 'go',
  tMs: 1000,
  stateHash: 'h',
  signals: [],
  outcome: 'ok',
};

function input(over: Partial<OracleInput> = {}): OracleInput {
  return { step, signals: [], observation: obs(), origin: ORIGIN, loggedIn: true, settleCappedCount: 0, ...over };
}

const net = (over: Partial<Extract<Signal, { kind: 'network' }>> = {}): Signal => ({
  kind: 'network',
  method: 'GET',
  url: `${ORIGIN}/api/cart`,
  status: 200,
  durationMs: 50,
  resourceType: 'fetch',
  tMs: 1100,
  ...over,
});

describe('oracles (pure)', () => {
  it('clean input fires nothing', () => {
    expect(runOracles(input({ signals: [net()] }))).toEqual([]);
  });

  it('pageerror -> one crash P1 with stack in evidence', () => {
    const c = runOracles(input({ signals: [{ kind: 'pageerror', message: 'TypeError: x is undefined', stack: 'at f (a.js:1:1)', tMs: 1200 }] }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ oracle: 'crash', severity: 'P1', stepN: 3, tMs: 1200, url: `${ORIGIN}/orders/12` });
    expect(c[0]!.evidence).toMatchObject({ stack: 'at f (a.js:1:1)' });
  });

  it('console.error -> console P2; warnings ignored', () => {
    const e: Signal = { kind: 'console', level: 'error', text: 'Failed to load thing', tMs: 1 };
    const w: Signal = { kind: 'console', level: 'warning', text: 'meh', tMs: 1 };
    const c = runOracles(input({ signals: [e, w] }));
    expect(c.map((x) => [x.oracle, x.severity])).toEqual([['console', 'P2']]);
  });

  it.each([
    'GET http://x.test/favicon.ico 404',
    'Download the React DevTools for a better development experience',
    '[HMR] connected',
    'ResizeObserver loop completed with undelivered notifications.',
  ])('console noise is ignored: %s', (text) => {
    expect(runOracles(input({ signals: [{ kind: 'console', level: 'error', text, tMs: 1 }] }))).toEqual([]);
  });

  it('500 same-origin -> network P1 with status and bodyKey', () => {
    const c = runOracles(input({ signals: [net({ status: 500, bodyKey: 'k/bodies/1.txt' })] }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ oracle: 'network', severity: 'P1' });
    expect(c[0]!.evidence).toMatchObject({ status: 500, bodyKey: 'k/bodies/1.txt', method: 'GET' });
  });

  it('404 on xhr/fetch -> network P2', () => {
    const c = runOracles(input({ signals: [net({ status: 404, resourceType: 'xhr' })] }));
    expect(c.map((x) => [x.oracle, x.severity])).toEqual([['network', 'P2']]);
  });

  it('4xx on images/scripts does not fire', () => {
    expect(runOracles(input({ signals: [net({ status: 404, resourceType: 'image' })] }))).toEqual([]);
  });

  it('401 with loggedIn:false -> none; with loggedIn:true -> fires', () => {
    const s = [net({ status: 401 })];
    expect(runOracles(input({ signals: s, loggedIn: false }))).toEqual([]);
    expect(runOracles(input({ signals: s, loggedIn: true }))).toHaveLength(1);
  });

  it('503 to a third-party host -> none', () => {
    expect(runOracles(input({ signals: [net({ status: 503, url: 'https://analytics.thirdparty.test/collect' })] }))).toEqual([]);
  });

  it('failed same-origin fetch -> network P2; aborted ones ignored', () => {
    const f = net({ status: null, failure: 'net::ERR_CONNECTION_RESET' });
    expect(runOracles(input({ signals: [f] })).map((x) => [x.oracle, x.severity])).toEqual([['network', 'P2']]);
    expect(runOracles(input({ signals: [net({ status: null, failure: 'net::ERR_ABORTED' })] }))).toEqual([]);
  });

  it('document response >=400 -> http P1 only (no network duplicate)', () => {
    const c = runOracles(input({ signals: [net({ status: 404, resourceType: 'document', url: `${ORIGIN}/gone` })] }));
    expect(c.map((x) => [x.oracle, x.severity])).toEqual([['http', 'P1']]);
    const c500 = runOracles(input({ signals: [net({ status: 500, resourceType: 'document', url: `${ORIGIN}/gone` })] }));
    expect(c500.map((x) => x.oracle)).toEqual(['http']);
  });

  it('"Total: NaN" -> error_text P2; "Not a number" -> none', () => {
    const c = runOracles(input({ observation: obs({ text: 'Cart summary. Total: NaN for your items' }) }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ oracle: 'error_text', severity: 'P2' });
    expect(c[0]!.message).toContain('NaN');
    expect(runOracles(input({ observation: obs({ text: 'Please enter a value. Not a number, try again please.' }) }))).toEqual([]);
  });

  it.each(['Price: undefined', 'Hello null today', 'Item [object Object] here', 'Oops, Something went wrong!', 'Error\n   at foo (http://x/a.js:10:5)'])(
    'error_text fires for %s',
    (t) => {
      const c = runOracles(input({ observation: obs({ text: `Page content ${t} more filler` }) }));
      expect(c.map((x) => x.oracle)).toEqual(['error_text']);
    },
  );

  it('error_text also reads alerts; words inside other words do not match', () => {
    expect(runOracles(input({ observation: obs({ alerts: ['Something went wrong'] }) })).map((x) => x.oracle)).toEqual(['error_text']);
    expect(runOracles(input({ observation: obs({ text: 'Banana nullable undefinedness' }) }))).toEqual([]);
  });

  it('blank: <20 chars and no interactables -> P1; interactable or text saves it', () => {
    const blank = obs({ text: 'hello', interactables: [] });
    const c = runOracles(input({ observation: blank }));
    expect(c.map((x) => [x.oracle, x.severity])).toEqual([['blank', 'P1']]);
    expect(runOracles(input({ observation: obs({ text: 'hello' }) }))).toEqual([]);
    expect(runOracles(input({ observation: obs({ text: 'x'.repeat(30), interactables: [] }) }))).toEqual([]);
  });

  it('slow: settleCappedCount 3 -> P3; request >5000ms -> P3; 2 caps and fast requests -> none', () => {
    expect(runOracles(input({ settleCappedCount: 3 })).map((x) => [x.oracle, x.severity])).toEqual([['slow', 'P3']]);
    expect(runOracles(input({ settleCappedCount: 2 }))).toEqual([]);
    const c = runOracles(input({ signals: [net({ durationMs: 6200 })] }));
    expect(c.map((x) => [x.oracle, x.severity])).toEqual([['slow', 'P3']]);
    expect(c[0]!.evidence).toMatchObject({ durationMs: 6200 });
  });

  it('suppressed signatures are dropped', () => {
    const signals = [net({ status: 500 })];
    const [c] = runOracles(input({ signals }));
    expect(runOracles(input({ signals }), { suppressed: new Set([c!.signature]) })).toEqual([]);
  });

  it('de-dupes identical candidates within one call', () => {
    const signals = [net({ status: 500 }), net({ status: 500, tMs: 1300 })];
    expect(runOracles(input({ signals }))).toHaveLength(1);
    // numeric ids normalise to the same signature
    const two = [net({ status: 500, url: `${ORIGIN}/api/orders/1` }), net({ status: 500, url: `${ORIGIN}/api/orders/2` })];
    expect(runOracles(input({ signals: two }))).toHaveLength(1);
  });

  it('only signals handed in are used (caller windows by step)', () => {
    expect(runOracles(input({ signals: [] }))).toEqual([]);
  });

  it('signatureFor is stable across ids and numbers', () => {
    const a = signatureFor('network', `${ORIGIN}/orders/12`, 'id 12 failed');
    const b = signatureFor('network', `${ORIGIN}/orders/99`, 'id 99 failed');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(signatureFor('crash', `${ORIGIN}/orders/12`, 'id 12 failed')).not.toBe(a);
    expect(signatureFor('network', `${ORIGIN}/other`, 'id 12 failed')).not.toBe(a);
  });

  it('signatureFor normalises uuids, hex, timestamps and long quoted strings', () => {
    const f = (m: string) => signatureFor('console', ORIGIN + '/', m);
    expect(f('user 3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab missing')).toBe(f('user 00000000-1111-2222-3333-444444444444 missing'));
    expect(f('token deadbeefcafe1234 bad')).toBe(f('token 0123456789abcdef bad')); // hex >= 8
    expect(f('at 2026-10-26T10:00:00.000Z boom')).toBe(f('at 2027-01-01T01:02:03Z boom'));
    expect(f(`bad "${'a'.repeat(50)}" value`)).toBe(f(`bad "${'b'.repeat(60)}" value`));
    expect(f('bad "short" value')).not.toBe(f('bad "other" value'));
  });

  it('never echoes more than 200 chars of page or signal content', () => {
    const secret = 'S3cret' + 'x'.repeat(500);
    const long = `Total: NaN ${secret}`;
    const cs = runOracles(
      input({
        observation: obs({ text: long }),
        signals: [
          { kind: 'pageerror', message: long, stack: long, tMs: 1 },
          { kind: 'console', level: 'error', text: long, tMs: 1 },
        ],
      }),
    );
    expect(cs.length).toBeGreaterThanOrEqual(3);
    for (const c of cs) {
      expect(c.message.length).toBeLessThanOrEqual(200);
      for (const v of Object.values(c.evidence)) if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(200);
      expect(JSON.stringify(c)).not.toContain('x'.repeat(201));
    }
  });
});

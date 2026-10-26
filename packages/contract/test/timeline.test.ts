import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CliEnvelope, ReplayTimeline, cliEnvelope } from '../src/index.js';

describe('ReplayTimeline', () => {
  it('round-trips through JSON', () => {
    const t: ReplayTimeline = {
      runId: 'r1',
      t0: 1700000000000,
      durationMs: 5000,
      videoKey: 'v.webm',
      rrwebSegments: [{ index: 0, startMs: 0, endMs: 1000, url: 'http://x/0', key: 'k0' }],
      steps: [
        {
          n: 1,
          action: { type: 'click', ref: 'e1', intent: 'open' },
          locator: { css: '#a', testId: 'a' },
          intent: 'open',
          tMs: 10,
          stateHash: 'h',
          signals: [{ kind: 'console', level: 'error', text: 'boom', tMs: 12 }],
          outcome: 'ok',
        },
      ],
      signals: [{ kind: 'network', method: 'GET', url: '/a', status: null, failure: 'x', durationMs: 5, resourceType: 'fetch', tMs: 3 }],
      findings: [{ id: 'f1', tMs: 12 }],
    };
    expect(ReplayTimeline.parse(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });
});

describe('cliEnvelope', () => {
  it('wraps data schema', () => {
    const E = cliEnvelope(z.object({ a: z.number() }));
    const v: CliEnvelope<{ a: number }> = E.parse({ schemaVersion: 1, status: 'ok', data: { a: 1 } });
    expect(v.data.a).toBe(1);
    expect(E.safeParse({ schemaVersion: 2, status: 'ok', data: { a: 1 } }).success).toBe(false);
  });
});

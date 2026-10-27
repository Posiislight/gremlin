import { describe, expect, it } from 'vitest';
import {
  adjacentStep,
  alignedTime,
  buildMarkers,
  offsetInSegment,
  screenshotAt,
  segmentForTime,
  signalsUpTo,
  stepAtTime,
  timeForStep,
} from '../src/lib/replay/sync';
import type { RrwebSegment, Signal, TimelineStep } from '../src/lib/types';

const step = (n: number, tMs: number, extra: Partial<TimelineStep> = {}): TimelineStep => ({
  n,
  action: { type: 'wait', ms: 1, intent: 'x' },
  locator: null,
  intent: `step ${n}`,
  tMs,
  stateHash: 'h',
  signals: [],
  outcome: 'ok',
  screenshotUrl: null,
  ...extra,
});

const steps = [step(1, 0), step(2, 1000), step(3, 2500), step(4, 4000)];

describe('stepAtTime', () => {
  it('returns null before the first step', () => {
    expect(stepAtTime([step(1, 500)], 100)).toBeNull();
  });
  it('picks the last step at or before t', () => {
    expect(stepAtTime(steps, 0)?.n).toBe(1);
    expect(stepAtTime(steps, 999)?.n).toBe(1);
    expect(stepAtTime(steps, 1000)?.n).toBe(2);
    expect(stepAtTime(steps, 3999)?.n).toBe(3);
    expect(stepAtTime(steps, 99999)?.n).toBe(4);
  });
  it('tolerates unsorted input', () => {
    expect(stepAtTime([steps[2]!, steps[0]!, steps[1]!], 1500)?.n).toBe(2);
  });
});

describe('timeForStep / adjacentStep', () => {
  it('maps step numbers to times', () => {
    expect(timeForStep(steps, 3)).toBe(2500);
    expect(timeForStep(steps, 9)).toBeNull();
  });
  it('moves forward and clamps at the end', () => {
    expect(adjacentStep(steps, 1200, 1)?.n).toBe(3);
    expect(adjacentStep(steps, 4000, 1)?.n).toBe(4);
  });
  it('previous restarts the current step when past it, else goes back', () => {
    expect(adjacentStep(steps, 1800, -1)?.n).toBe(2);
    expect(adjacentStep(steps, 1000, -1)?.n).toBe(1);
    expect(adjacentStep(steps, 0, -1)?.n).toBe(1);
  });
  it('returns null for empty steps', () => {
    expect(adjacentStep([], 0, 1)).toBeNull();
  });
});

describe('signals + markers', () => {
  const signals: Signal[] = [
    { kind: 'console', level: 'error', text: 'boom', tMs: 1100 },
    { kind: 'console', level: 'warning', text: 'meh', tMs: 1200 },
    { kind: 'network', method: 'POST', url: '/api/cart', status: 500, durationMs: 80, resourceType: 'fetch', tMs: 2600 },
    { kind: 'network', method: 'GET', url: '/ok', status: 200, durationMs: 5, resourceType: 'fetch', tMs: 2700 },
    { kind: 'navigation', url: '/shop', tMs: 10 },
  ];
  it('filters signals by playhead', () => {
    expect(signalsUpTo(signals, 1150).map((s) => s.tMs)).toEqual([10, 1100]);
  });
  it('builds scrubber markers with percentages', () => {
    const m = buildMarkers({
      steps: [step(1, 0), step(2, 5000, { outcome: 'error' })],
      signals,
      findings: [{ id: 'f1', tMs: 5000 }],
      durationMs: 10000,
    });
    const kinds = m.map((x) => x.kind);
    expect(kinds).toContain('step_fail');
    expect(kinds).toContain('console_error');
    expect(kinds).toContain('net_fail');
    expect(kinds).toContain('finding');
    expect(kinds).not.toContain('net_ok');
    expect(m.filter((x) => x.kind === 'console_error')).toHaveLength(1);
    expect(m.find((x) => x.kind === 'finding')?.pct).toBe(50);
    expect([...m].sort((a, b) => a.tMs - b.tMs)).toEqual(m);
  });
});

describe('rrweb segments', () => {
  const seg = (index: number, startMs: number, endMs: number): RrwebSegment => ({ index, startMs, endMs, url: 'u', key: 'k', signedUrl: 's' });
  const segs = [seg(1, 3000, 6000), seg(0, 0, 3000)];
  it('picks the covering segment', () => {
    expect(segmentForTime(segs, 100)?.index).toBe(0);
    expect(segmentForTime(segs, 3500)?.index).toBe(1);
    expect(segmentForTime(segs, 99999)?.index).toBe(1);
    expect(segmentForTime([], 1)).toBeNull();
  });
  it('computes clamped offsets', () => {
    expect(offsetInSegment(seg(1, 3000, 6000), 4500)).toBe(1500);
    expect(offsetInSegment(seg(1, 3000, 6000), 100)).toBe(0);
    expect(offsetInSegment(seg(1, 3000, 6000), 9000)).toBe(3000);
  });
});

describe('screenshotAt', () => {
  const withShots = [step(1, 0, { screenshotUrl: 'a' }), step(2, 1000), step(3, 2000, { screenshotUrl: 'c' })];
  it('uses the latest screenshot at or before t', () => {
    expect(screenshotAt(withShots, 1500)?.url).toBe('a');
    expect(screenshotAt(withShots, 2000)?.url).toBe('c');
  });
  it('falls back to the first available one', () => {
    expect(screenshotAt([step(1, 500, { screenshotUrl: 'z' })], 0)?.url).toBe('z');
    expect(screenshotAt([step(1, 0)], 0)).toBeNull();
  });
});

describe('alignedTime (compare)', () => {
  const a = { steps: [step(1, 0), step(2, 1000), step(3, 2000)], durationMs: 3000 };
  const b = { steps: [step(1, 0), step(2, 2000), step(3, 5000)], durationMs: 6000 };
  it('aligns by step number with proportional offset inside the step', () => {
    expect(alignedTime(a, b, 1000)).toBe(2000);
    expect(alignedTime(a, b, 1500)).toBe(3500);
  });
  it('falls back to proportional time when step missing', () => {
    expect(alignedTime({ steps: [], durationMs: 1000 }, b, 500)).toBe(3000);
  });
});

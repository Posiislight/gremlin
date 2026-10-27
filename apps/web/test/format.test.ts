import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatMs,
  formatPercent,
  formatTokens,
  formatUsd,
  groupByPriority,
  httpTone,
  relativeTime,
  shortUrl,
  stepGlyph,
  stepTarget,
  stepVerb,
} from '../src/lib/replay/format';
import { buildReplayLink, parseReplayLink } from '../src/lib/replay/deeplink';
import { consoleEntries, filterConsole, networkEntries, waterfall } from '../src/lib/replay/devtools';
import { metricDelta, sparkPath } from '../src/lib/replay/metrics';
import type { MetricPoint, Signal } from '../src/lib/types';

describe('shortId', () => {
  it('keeps ids short for display', async () => {
    const { shortId } = await import('../src/lib/replay/format');
    expect(shortId('emil4sqpx3ksuosefsgwe8zy')).toBe('#emil4s');
    expect(shortId('scn_live')).toBe('#live');
    expect(shortId('run_demo')).toBe('#demo');
  });
});

describe('format', () => {
  it('formats times', () => {
    expect(formatMs(0)).toBe('0:00.000');
    expect(formatMs(65432)).toBe('1:05.432');
    expect(formatDuration(840)).toBe('840ms');
    expect(formatDuration(12400)).toBe('12.4s');
    expect(formatDuration(185000)).toBe('3m 05s');
    expect(formatDuration(null)).toBe('-');
  });
  it('formats sizes and money', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1.256)).toBe('$1.26');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_500)).toBe('13k');
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatPercent(null)).toBe('-');
  });
  it('relative time', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(relativeTime('2026-10-27T11:59:30Z', now)).toBe('30s ago');
    expect(relativeTime('2026-10-27T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime(null, now)).toBe('-');
  });
  it('shortens urls in the middle', () => {
    expect(shortUrl('https://shop.test/cart?x=1')).toBe('/cart?x=1');
    const long = shortUrl('https://shop.test/' + 'a'.repeat(100), 20);
    expect(long.length).toBe(20);
    expect(long).toContain('…');
  });
  it('describes steps', () => {
    const goto = { action: { type: 'goto', path: '/shop', intent: 'i' } as const, locator: null };
    expect(stepVerb(goto)).toBe('goto /shop');
    expect(stepTarget(goto)).toBeNull();
    const click = { action: { type: 'click', ref: 'e12', intent: 'i' } as const, locator: { role: { role: 'button', name: 'Add to cart' }, css: 'button' } };
    expect(stepVerb(click)).toBe('click');
    expect(stepTarget(click)).toBe('Add to cart');
  });
  it('step glyphs', () => {
    expect(stepGlyph({ outcome: 'ok', signals: [] })).toBe('ok');
    expect(stepGlyph({ outcome: 'error', signals: [] })).toBe('fail');
    expect(stepGlyph({ outcome: 'ok', signals: [{ kind: 'pageerror', message: 'x', tMs: 1 }] })).toBe('warn');
  });
  it('groups by priority in order', () => {
    const g = groupByPriority([{ priority: 'P2' as const }, { priority: 'P0' as const }, { priority: 'P2' as const }]);
    expect(g.map((x) => [x.priority, x.items.length])).toEqual([['P0', 1], ['P2', 2]]);
  });
  it('http tone', () => {
    expect(httpTone(200)).toBe('ok');
    expect(httpTone(404)).toBe('client');
    expect(httpTone(503)).toBe('server');
    expect(httpTone(null, 'net::ERR')).toBe('failed');
  });
});

describe('deeplink', () => {
  it('parses step and finding', () => {
    expect(parseReplayLink({ step: '7', finding: 'fnd_1' })).toEqual({ step: 7, finding: 'fnd_1' });
    expect(parseReplayLink(new URLSearchParams('step=abc&finding=a b'))).toEqual({ step: null, finding: null });
    expect(parseReplayLink({ step: ['3', '4'] })).toEqual({ step: 3, finding: null });
  });
  it('builds links', () => {
    expect(buildReplayLink('https://x.dev/', 'run_1', { step: 3, finding: 'f1' })).toBe('https://x.dev/runs/run_1?step=3&finding=f1');
    expect(buildReplayLink('https://x.dev', 'run_1', {})).toBe('https://x.dev/runs/run_1');
  });
});

describe('devtools', () => {
  const sigs: Signal[] = [
    { kind: 'console', level: 'warning', text: 'Deprecated thing', location: 'a.js:1', tMs: 5 },
    { kind: 'pageerror', message: 'TypeError: x is undefined', stack: 'at y', tMs: 1 },
    { kind: 'network', method: 'GET', url: '/a', status: 200, durationMs: 100, resourceType: 'fetch', tMs: 0 },
    { kind: 'network', method: 'POST', url: '/b', status: 500, durationMs: 100, resourceType: 'fetch', tMs: 100 },
  ];
  it('derives console entries and filters', () => {
    const c = consoleEntries(sigs);
    expect(c.map((e) => e.level)).toEqual(['error', 'warning']);
    expect(filterConsole(c, new Set(['error'])).length).toBe(1);
    expect(filterConsole(c, new Set(['error', 'warning']), 'deprecated').length).toBe(1);
  });
  it('derives network entries and waterfall', () => {
    const n = networkEntries(sigs);
    expect(n.map((e) => e.failed)).toEqual([false, true]);
    const w = waterfall(n);
    expect(w[0]).toEqual({ left: 0, width: 50 });
    expect(w[1]!.left).toBe(50);
    expect(waterfall([])).toEqual([]);
  });
});

describe('metrics', () => {
  const p = (o: Partial<MetricPoint>): MetricPoint => ({
    scanId: 's', label: 'l', tokens: 100, costUsd: 1, wallMs: 1000, stepsPerFinding: 10, falsePositiveRate: 0.2, confirmed: 3, regressionCatches: 0, ...o,
  });
  it('flags improvement direction per metric', () => {
    const pts = [p({ tokens: 200, confirmed: 2 }), p({ tokens: 100, confirmed: 4 })];
    expect(metricDelta(pts, 'tokens')).toMatchObject({ delta: -100, pct: -0.5, improved: true });
    expect(metricDelta(pts, 'confirmed').improved).toBe(true);
    expect(metricDelta([pts[1]!, p({ tokens: 300 })], 'tokens').improved).toBe(false);
  });
  it('handles a single point', () => {
    expect(metricDelta([p({})], 'tokens').improved).toBeNull();
  });
  it('sparkline path', () => {
    expect(sparkPath([], 10, 10)).toBe('');
    expect(sparkPath([1, 2], 12, 12, 2)).toBe('M2.0,10.0 L10.0,2.0');
  });
});

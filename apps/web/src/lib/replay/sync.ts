// Pure playhead <-> timeline logic. One playhead (tMs) drives every view.
import type { RrwebSegment, Signal, TimelineStep } from '../types';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

type Timed = { n: number; tMs: number };

/** Steps are not guaranteed sorted; work on a sorted copy. */
export function sortSteps<T extends Timed>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => a.tMs - b.tMs || a.n - b.n);
}

/** Last step whose tMs <= t (the step "in progress" at the playhead). Null before the first step. */
export function stepAtTime<T extends Timed>(steps: readonly T[], tMs: number): T | null {
  const sorted = sortSteps(steps);
  let lo = 0;
  let hi = sorted.length - 1;
  let ans: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.tMs <= tMs) {
      ans = sorted[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function stepByN<T extends Timed>(steps: readonly T[], n: number): T | null {
  return steps.find((s) => s.n === n) ?? null;
}

/** Time to seek to for a step number; null if unknown. */
export function timeForStep(steps: readonly Timed[], n: number): number | null {
  return stepByN(steps, n)?.tMs ?? null;
}

/** Next (dir 1) or previous (dir -1) step relative to the playhead. Previous restarts the current step if we are past it. */
export function adjacentStep<T extends Timed>(steps: readonly T[], tMs: number, dir: 1 | -1): T | null {
  const sorted = sortSteps(steps);
  if (sorted.length === 0) return null;
  if (dir === 1) return sorted.find((s) => s.tMs > tMs) ?? sorted[sorted.length - 1]!;
  const cur = stepAtTime(sorted, tMs);
  if (!cur) return sorted[0]!;
  const idx = sorted.indexOf(cur);
  return cur.tMs < tMs - 250 ? cur : (sorted[Math.max(0, idx - 1)] ?? cur);
}

/** Signals that have already happened at tMs, in order. */
export function signalsUpTo(signals: readonly Signal[], tMs: number): Signal[] {
  return signals.filter((s) => s.tMs <= tMs).sort((a, b) => a.tMs - b.tMs);
}

export type MarkerKind = 'step' | 'step_fail' | 'console_error' | 'page_error' | 'net_fail' | 'finding' | 'navigation';
export type Marker = { kind: MarkerKind; tMs: number; pct: number; label: string; stepN?: number; findingId?: string };

export function isFailedNetwork(s: Signal): boolean {
  return s.kind === 'network' && (s.status == null ? !!s.failure : s.status >= 400);
}

/** Everything that deserves a tick on the scrubber, positioned in % of durationMs. */
export function buildMarkers(input: {
  steps: readonly TimelineStep[];
  signals: readonly Signal[];
  findings: readonly { id: string; tMs: number }[];
  durationMs: number;
}): Marker[] {
  const d = Math.max(1, input.durationMs);
  const pct = (t: number) => clamp((t / d) * 100, 0, 100);
  const out: Marker[] = [];
  for (const s of input.steps) {
    const bad = s.outcome === 'error' || s.outcome === 'model_error';
    out.push({ kind: bad ? 'step_fail' : 'step', tMs: s.tMs, pct: pct(s.tMs), label: `#${s.n} ${s.intent}`, stepN: s.n });
  }
  for (const g of input.signals) {
    if (g.kind === 'console' && g.level === 'error') out.push({ kind: 'console_error', tMs: g.tMs, pct: pct(g.tMs), label: g.text });
    else if (g.kind === 'pageerror') out.push({ kind: 'page_error', tMs: g.tMs, pct: pct(g.tMs), label: g.message });
    else if (g.kind === 'network' && isFailedNetwork(g))
      out.push({ kind: 'net_fail', tMs: g.tMs, pct: pct(g.tMs), label: `${g.method} ${g.url} ${g.status ?? g.failure ?? ''}` });
    else if (g.kind === 'navigation') out.push({ kind: 'navigation', tMs: g.tMs, pct: pct(g.tMs), label: g.url });
  }
  for (const f of input.findings) out.push({ kind: 'finding', tMs: f.tMs, pct: pct(f.tMs), label: `finding ${f.id}`, findingId: f.id });
  return out.sort((a, b) => a.tMs - b.tMs);
}

/** rrweb segment covering tMs; falls back to the nearest earlier one, then the first. */
export function segmentForTime(segments: readonly RrwebSegment[], tMs: number): RrwebSegment | null {
  if (segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  let pick = sorted[0]!;
  for (const s of sorted) if (s.startMs <= tMs) pick = s;
  return pick;
}

/** Offset passed to rrweb Replayer.goto(): ms since the first event of the loaded segment. */
export function offsetInSegment(segment: Pick<RrwebSegment, 'startMs' | 'endMs'>, tMs: number): number {
  const duration = Math.max(0, segment.endMs - segment.startMs);
  // rrweb seeks cast events with timestamp < target; include the last mutation at the boundary.
  return tMs >= segment.endMs ? duration + 1 : clamp(tMs - segment.startMs, 0, duration);
}

/** Screenshot to show at tMs: the latest step with one at/before the playhead, else the first available. */
export function screenshotAt(steps: readonly TimelineStep[], tMs: number): { step: TimelineStep; url: string } | null {
  const sorted = sortSteps(steps);
  let best: { step: TimelineStep; url: string } | null = null;
  for (const s of sorted) {
    if (s.tMs > tMs) break;
    if (s.screenshotUrl) best = { step: s, url: s.screenshotUrl };
  }
  if (best) return best;
  const first = sorted.find((s) => s.screenshotUrl);
  return first ? { step: first, url: first.screenshotUrl! } : null;
}

/** Step-aligned time for compare view: same step number in another run, proportional inside the step; falls back to proportional overall. */
export function alignedTime(
  a: { steps: readonly Timed[]; durationMs: number },
  b: { steps: readonly Timed[]; durationMs: number },
  tMs: number,
): number {
  const cur = stepAtTime(a.steps, tMs);
  if (cur) {
    const other = stepByN(b.steps, cur.n);
    if (other) {
      const next = sortSteps(a.steps).find((s) => s.tMs > cur.tMs);
      const span = (next?.tMs ?? a.durationMs) - cur.tMs;
      const frac = span > 0 ? clamp((tMs - cur.tMs) / span, 0, 1) : 0;
      const otherNext = sortSteps(b.steps).find((s) => s.tMs > other.tMs);
      return other.tMs + frac * ((otherNext?.tMs ?? b.durationMs) - other.tMs);
    }
  }
  return a.durationMs > 0 ? (tMs / a.durationMs) * b.durationMs : 0;
}

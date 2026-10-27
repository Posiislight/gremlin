import { ReplayTimeline } from '@gremlin/contract';

export type TimelineParts = ReplayTimeline;

/** Pure: assemble the replay timeline, ordering signals and findings by `tMs` and steps by `n`. */
export function buildTimeline(parts: TimelineParts): ReplayTimeline {
  const byTime = <T extends { tMs: number }>(xs: T[]): T[] => [...xs].sort((a, b) => a.tMs - b.tMs);
  return {
    ...parts,
    rrwebSegments: [...parts.rrwebSegments].sort((a, b) => a.index - b.index),
    steps: [...parts.steps].sort((a, b) => a.n - b.n),
    signals: byTime(parts.signals),
    findings: byTime(parts.findings),
  };
}

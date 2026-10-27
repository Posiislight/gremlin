// Re-exports engine API types (type-only, erased at build) plus dashboard-local shapes
// for endpoints that are not part of @gremlin/contract/api.ts yet.
import type { Signal, Step } from '@gremlin/contract';
import type {
  ApiFindingDetail,
  ApiFindingSummary,
  ApiOccurrence,
  ApiProject,
  ApiRunSummary,
  ApiScan,
  ApiScanDetail,
  ApiTimeline,
  ScanEvent,
} from '@gremlin/contract';

export type {
  ApiFindingDetail,
  ApiFindingSummary,
  ApiOccurrence,
  ApiProject,
  ApiRunSummary,
  ApiScan,
  ApiScanDetail,
  ApiTimeline,
  ScanEvent,
  Signal,
  Step,
};

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type TimelineStep = ApiTimeline['steps'][number];
export type RrwebSegment = ApiTimeline['rrwebSegments'][number];

/** Spec 11.5: this scan vs the previous scan on the same project. */
export type MetricPoint = {
  scanId: string;
  label: string;
  tokens: number;
  costUsd: number;
  wallMs: number;
  stepsPerFinding: number;
  falsePositiveRate: number;
  confirmed: number;
  regressionCatches: number;
};
export type ProjectMetrics = {
  projectId: string;
  points: MetricPoint[];
  fixRate: number | null;
  medianTimeToFixMs: number | null;
};

export type ScanListItem = ApiScan & { projectId: string; findingCount: number; p0: number; p1: number };

/** Where a payload came from, so the UI can show a MOCK badge. */
export type Sourced<T> = { data: T; source: 'engine' | 'mock' };

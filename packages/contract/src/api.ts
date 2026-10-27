// Engine HTTP API (spec section 16): request and response schemas shared with the dashboard.
import { z } from 'zod';
import { Priority } from './common.js';
import { FindingStatus, JudgeVerdict } from './finding.js';
import { ReplayTimeline } from './timeline.js';
import { Step } from './step.js';

const iso = z.string();

export const ApiError = z.object({ error: z.string(), issues: z.array(z.unknown()).optional() });
export type ApiError = z.infer<typeof ApiError>;

export const ApiProject = z.object({ id: z.string(), name: z.string(), createdAt: iso });
export type ApiProject = z.infer<typeof ApiProject>;
export const ListProjectsResponse = z.object({ projects: z.array(ApiProject) });
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>;

export const ApiFindingSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  scanId: z.string().nullable(),
  signature: z.string(),
  priority: Priority,
  title: z.string(),
  expected: z.string(),
  actual: z.string(),
  status: z.string(),
  url: z.string().nullable(),
  oracle: z.string().nullable(),
  unjudged: z.boolean(),
  fixStatus: z.string().nullable(),
  occurrenceCount: z.number().int(),
  createdAt: iso,
});
export type ApiFindingSummary = z.infer<typeof ApiFindingSummary>;

export const ListFindingsQuery = z.object({
  status: FindingStatus.optional(),
  priority: Priority.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListFindingsQuery = z.infer<typeof ListFindingsQuery>;
export const ListFindingsResponse = z.object({ findings: z.array(ApiFindingSummary) });
export type ListFindingsResponse = z.infer<typeof ListFindingsResponse>;

export const ApiOccurrence = z.object({
  runId: z.string(),
  stepId: z.string(),
  stepN: z.number().int(),
  tMs: z.number(),
  intent: z.string().nullable(),
  screenshotUrl: z.string().nullable(),
});
export type ApiOccurrence = z.infer<typeof ApiOccurrence>;

export const ApiFindingDetail = ApiFindingSummary.extend({
  verdict: JudgeVerdict.or(z.object({ reason: z.string() })).nullable(),
  confirm: z.unknown().nullable(),
  promptVariant: z.string().nullable(),
  occurrences: z.array(ApiOccurrence),
  screenshotUrls: z.array(z.string()),
});
export type ApiFindingDetail = z.infer<typeof ApiFindingDetail>;

export const PatchFindingBody = z.object({ status: z.enum(['new', 'confirmed', 'dismissed', 'fixed']) });
export type PatchFindingBody = z.infer<typeof PatchFindingBody>;

export const ApiRunStep = z.object({
  id: z.string(),
  n: z.number().int(),
  action: z.unknown(),
  locator: z.unknown().nullable(),
  intent: z.string().nullable(),
  expectation: z.string().nullable(),
  tMs: z.number(),
  stateHash: z.string().nullable(),
  outcome: z.string().nullable(),
  error: z.string().nullable(),
  reasoningSummary: z.string().nullable(),
  signals: z.array(z.unknown()),
  screenshotUrl: z.string().nullable(),
});
export type ApiRunStep = z.infer<typeof ApiRunStep>;

export const ApiRunSummary = z.object({
  id: z.string(),
  scanId: z.string().nullable(),
  charterId: z.string().nullable(),
  kind: z.enum(['scan', 'confirm', 'live', 'verify', 'scenario']),
  status: z.string(),
  t0: iso.nullable(),
  tokens: z.number().int(),
  costUsd: z.number(),
  error: z.string().nullable(),
  hasVideo: z.boolean(),
  hasRrweb: z.boolean(),
  hasTimeline: z.boolean(),
});
export type ApiRunSummary = z.infer<typeof ApiRunSummary>;

export const ApiRun = ApiRunSummary.extend({
  charter: z
    .object({ id: z.string(), type: z.string(), area: z.string().nullable(), goal: z.string(), viewport: z.string().nullable() })
    .nullable(),
  videoUrl: z.string().nullable(),
  traceUrl: z.string().nullable(),
  timelineUrl: z.string().nullable(),
  steps: z.array(ApiRunStep),
});
export type ApiRun = z.infer<typeof ApiRun>;

/** The stored timeline.json plus signed URLs for its artifacts. */
export const ApiTimeline = ReplayTimeline.extend({
  videoUrl: z.string().nullable(),
  traceUrl: z.string().nullable(),
  rrwebSegments: z.array(
    ReplayTimeline.shape.rrwebSegments.element.extend({ signedUrl: z.string() }),
  ),
  steps: z.array(Step.extend({ screenshotUrl: z.string().nullable() })),
});
export type ApiTimeline = z.infer<typeof ApiTimeline>;

export const ApiScan = z.object({
  id: z.string(),
  environmentId: z.string(),
  baseUrl: z.string(),
  status: z.string(),
  teamSize: z.number().int(),
  allowedActions: z.string(),
  focus: z.string().nullable(),
  viewports: z.array(z.string()).nullable(),
  costUsd: z.number(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});
export type ApiScan = z.infer<typeof ApiScan>;

export const ApiScanDetail = ApiScan.extend({
  runs: z.array(ApiRunSummary),
  findings: z.array(ApiFindingSummary),
  cost: z.object({ scanUsd: z.number(), runsUsd: z.number(), llmUsd: z.number(), tokens: z.number().int() }),
});
export type ApiScanDetail = z.infer<typeof ApiScanDetail>;

export const CreateScanResponse = z.object({ scanId: z.string() });
export type CreateScanResponse = z.infer<typeof CreateScanResponse>;

/** One SSE message on GET /v1/scans/:id/events (`event:` is the `type`, `data:` is this JSON). */
export const ScanEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scan'), scanId: z.string(), status: z.string(), costUsd: z.number() }),
  z.object({ type: z.literal('run'), runId: z.string(), kind: z.string(), status: z.string(), error: z.string().nullable() }),
  z.object({
    type: z.literal('step'),
    runId: z.string(),
    stepId: z.string(),
    n: z.number().int(),
    intent: z.string().nullable(),
    outcome: z.string().nullable(),
    tMs: z.number(),
  }),
  z.object({ type: z.literal('finding'), finding: ApiFindingSummary }),
  z.object({ type: z.literal('done'), status: z.string() }),
]);
export type ScanEvent = z.infer<typeof ScanEvent>;

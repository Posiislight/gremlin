import { z } from 'zod';
import { Priority } from './common.js';

export const OracleKind = z.enum([
  'crash',
  'console',
  'network',
  'http',
  'dead_link',
  'error_text',
  'blank',
  'a11y',
  'layout',
  'vitals',
  'slow',
  'permission',
  'expectation',
  'agent_report',
]);
export type OracleKind = z.infer<typeof OracleKind>;

export const Candidate = z.object({
  oracle: OracleKind,
  stepN: z.number().int(),
  tMs: z.number(),
  url: z.string(),
  message: z.string(),
  severity: Priority,
  signature: z.string(),
  evidence: z.record(z.string(), z.unknown()),
});
export type Candidate = z.infer<typeof Candidate>;

export const FindingStatus = z.enum([
  'new',
  'confirmed',
  'flaky',
  'unconfirmed',
  'dismissed',
  'fixed',
  'still_failing',
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Finding = z.object({
  id: z.string(),
  scanId: z.string(),
  signature: z.string(),
  priority: Priority,
  title: z.string(),
  expected: z.string(),
  actual: z.string(),
  steps: z.array(z.object({ n: z.number().int(), text: z.string(), tMs: z.number() })),
  evidence: z.object({
    videoUrl: z.string().optional(),
    traceUrl: z.string().optional(),
    timelineUrl: z.string().optional(),
    screenshotUrls: z.array(z.string()),
  }),
  status: FindingStatus,
  url: z.string(),
  createdAt: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const JudgeVerdict = z.object({
  isBug: z.boolean(),
  priority: Priority,
  title: z.string(),
  expected: z.string(),
  actual: z.string(),
  duplicateOf: z.string().nullable(),
  reasoning: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

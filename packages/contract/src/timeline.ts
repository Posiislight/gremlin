import { z } from 'zod';
import { Signal } from './signal.js';
import { Step } from './step.js';

export const ReplayTimeline = z.object({
  runId: z.string(),
  t0: z.number(),
  durationMs: z.number(),
  videoKey: z.string().optional(),
  traceKey: z.string().optional(),
  rrwebSegments: z.array(
    z.object({
      index: z.number().int(),
      startMs: z.number(),
      endMs: z.number(),
      url: z.string(),
      key: z.string(),
    }),
  ),
  steps: z.array(Step),
  signals: z.array(Signal),
  findings: z.array(z.object({ id: z.string(), tMs: z.number() })),
});
export type ReplayTimeline = z.infer<typeof ReplayTimeline>;

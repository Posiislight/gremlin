import { z } from 'zod';
import { Action } from './action.js';
import { Locator } from './common.js';
import { Signal } from './signal.js';

export const StepOutcome = z.enum(['ok', 'error', 'blocked_by_policy', 'model_error', 'noop']);
export type StepOutcome = z.infer<typeof StepOutcome>;

export const Step = z.object({
  n: z.number().int(),
  action: Action,
  locator: Locator.nullable(),
  intent: z.string(),
  expectation: z.string().optional(),
  tMs: z.number(),
  stateHash: z.string(),
  screenshotKey: z.string().optional(),
  signals: z.array(Signal),
  outcome: StepOutcome,
  error: z.string().optional(),
  reasoningSummary: z.string().optional(),
});
export type Step = z.infer<typeof Step>;

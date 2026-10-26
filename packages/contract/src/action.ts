import { z } from 'zod';
import { Priority } from './common.js';

const intent = z.string();

export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ref: z.string(), intent }),
  z.object({ type: z.literal('type'), ref: z.string(), text: z.string(), submit: z.boolean().optional(), intent }),
  z.object({ type: z.literal('select'), ref: z.string(), option: z.string(), intent }),
  z.object({ type: z.literal('press'), key: z.string(), intent }),
  z.object({ type: z.literal('hover'), ref: z.string(), intent }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), intent }),
  z.object({ type: z.literal('upload'), ref: z.string(), fixture: z.string(), intent }),
  z.object({
    type: z.literal('goto'),
    path: z.string().regex(/^\/(?!\/)/, 'path must start with a single "/"'),
    intent,
  }),
  z.object({ type: z.literal('back'), intent }),
  z.object({ type: z.literal('refresh'), intent }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(3000), intent }),
  z.object({ type: z.literal('expect'), statement: z.string(), intent }),
  z.object({
    type: z.literal('report_bug'),
    title: z.string(),
    expected: z.string(),
    actual: z.string(),
    severityHint: Priority,
    intent,
  }),
  z.object({ type: z.literal('finish'), reason: z.string(), intent }),
]);
export type Action = z.infer<typeof Action>;

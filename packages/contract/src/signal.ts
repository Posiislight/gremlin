import { z } from 'zod';

export const Signal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('console'),
    level: z.enum(['error', 'warning']),
    text: z.string(),
    location: z.string().optional(),
    tMs: z.number(),
  }),
  z.object({
    kind: z.literal('pageerror'),
    message: z.string(),
    stack: z.string().optional(),
    tMs: z.number(),
  }),
  z.object({
    kind: z.literal('network'),
    method: z.string(),
    url: z.string(),
    status: z.number().nullable(),
    failure: z.string().optional(),
    durationMs: z.number(),
    resourceType: z.string(),
    bodyKey: z.string().optional(),
    tMs: z.number(),
  }),
  z.object({ kind: z.literal('navigation'), url: z.string(), tMs: z.number() }),
  z.object({ kind: z.literal('policy'), method: z.string(), url: z.string(), tMs: z.number() }),
]);
export type Signal = z.infer<typeof Signal>;

import { z } from 'zod';

export function cliEnvelope<T extends z.ZodType>(schema: T) {
  return z.object({
    schemaVersion: z.literal(1),
    status: z.enum(['ok', 'error']),
    errorCode: z.string().optional(),
    retryable: z.boolean().optional(),
    nextCommands: z.array(z.string()).optional(),
    data: schema,
  });
}

export type CliEnvelope<T> = {
  schemaVersion: 1;
  status: 'ok' | 'error';
  errorCode?: string | undefined;
  retryable?: boolean | undefined;
  nextCommands?: string[] | undefined;
  data: T;
};

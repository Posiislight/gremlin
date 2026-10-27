import { z } from 'zod';

export const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof Priority>;

export const Locator = z.object({
  testId: z.string().optional(),
  role: z.object({ role: z.string(), name: z.string() }).optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  text: z.string().optional(),
  css: z.string(),
});
export type Locator = z.infer<typeof Locator>;

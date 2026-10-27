import { z } from 'zod';

export const Charter = z.object({
  id: z.string(),
  area: z.string(),
  goal: z.string(),
  persona: z.string().optional(),
  type: z.enum(['happy_path', 'edge_input', 'navigation', 'permission', 'reproduce', 'regression']),
  startPath: z.string(),
  focus: z.string().optional(),
  risk: z.number(),
  viewport: z.enum(['desktop', 'mobile']),
});
export type Charter = z.infer<typeof Charter>;

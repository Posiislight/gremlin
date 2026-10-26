import { parse } from 'yaml';
import { z } from 'zod';

export const Scenario = z.object({
  name: z.string(),
  persona: z.string(),
  allowed_actions: z.enum(['read_only', 'full']),
  viewport: z.enum(['desktop', 'mobile']).optional(),
  starting_conditions: z.array(z.string()).optional(),
  steps: z.array(z.string()).min(1),
  outcomes: z.array(z.string()).min(1),
  triggers: z.array(z.string()).optional(),
});
export type Scenario = z.infer<typeof Scenario>;

export interface ScenarioIssue {
  path: string;
  message: string;
}

export class ScenarioParseError extends Error {
  readonly issues: ScenarioIssue[];
  constructor(issues: ScenarioIssue[]) {
    super(`Invalid scenario: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'ScenarioParseError';
    this.issues = issues;
  }
}

export function parseScenarioYaml(text: string): Scenario {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new ScenarioParseError([{ path: '', message: e instanceof Error ? e.message : String(e) }]);
  }
  const result = Scenario.safeParse(raw);
  if (!result.success) {
    throw new ScenarioParseError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function scenarioJsonSchema(): object {
  return z.toJSONSchema(Scenario);
}

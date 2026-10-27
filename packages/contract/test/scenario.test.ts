import { describe, expect, it } from 'vitest';
import { ScenarioParseError, parseScenarioYaml, scenarioJsonSchema } from '../src/index.js';

const yaml = `name: Guest adds item to cart
persona: guest
allowed_actions: full
steps: ["Open /shop", "Add 'Kayak' to cart"]
outcomes: ["Cart badge shows 1"]
triggers: ["/shop/**", "src/cart/**"]
`;

describe('scenario', () => {
  it('parses example yaml', () => {
    const s = parseScenarioYaml(yaml);
    expect(s.name).toBe('Guest adds item to cart');
    expect(s.steps).toHaveLength(2);
    expect(s.triggers).toEqual(['/shop/**', 'src/cart/**']);
  });
  it('throws ScenarioParseError with issues', () => {
    let err: unknown;
    try {
      parseScenarioYaml('name: x\nsteps: []');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScenarioParseError);
    const e = err as ScenarioParseError;
    const paths = e.issues.map((x) => x.path);
    expect(paths).toContain('steps');
    expect(paths).toContain('outcomes');
    expect(e.message).toContain('steps');
    expect(e.message).toContain('outcomes');
  });
  it('throws ScenarioParseError on invalid yaml', () => {
    expect(() => parseScenarioYaml('a: [')).toThrow(ScenarioParseError);
  });
  it('json schema requires name, steps, outcomes', () => {
    const js = scenarioJsonSchema() as { required: string[] };
    expect(js.required).toEqual(expect.arrayContaining(['name', 'steps', 'outcomes']));
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, Charter } from '@gremlin/contract';
import type { Llm, Role, ToolCallRequest } from '@gremlin/llm';

/** One scripted model turn: an action, an error to throw, or a function of the prompt the model received. */
export type ScriptItem = Action | Error | ((prompt: string) => Action | Error);

export type FakeLlm = Llm & { prompts: string[]; systems: string[]; calls: number };

/** Scripted navigator. Validates every returned action against the tool schema, like the real client. */
export function fakeLlm(script: ScriptItem[], fallback: ScriptItem = finish('script exhausted')): FakeLlm {
  let i = 0;
  const fake: FakeLlm = {
    prompts: [],
    systems: [],
    calls: 0,
    async callTool<T>(role: Role, req: ToolCallRequest<T>) {
      fake.calls += 1;
      const prompt = req.messages.map((m) => m.content).join('\n');
      fake.prompts.push(prompt);
      fake.systems.push(req.system);
      const item = i < script.length ? script[i++]! : fallback;
      const v = typeof item === 'function' ? item(prompt) : item;
      if (v instanceof Error) throw v;
      const value = req.tool.schema.parse(v);
      return { value, usage: { role, model: 'fake', tokensIn: 100, tokensOut: 10, latencyMs: 1, costUsd: null } };
    },
  };
  return fake;
}

export function finish(reason = 'done'): Action {
  return { type: 'finish', reason, intent: 'stop' };
}

/** Find the ref of the interactable named `name` in the observation the model was shown. */
export function refOf(prompt: string, name: string): string {
  const re = new RegExp(`^(e\\d+) \\S+ "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm');
  const m = re.exec(prompt);
  if (!m) throw new Error(`no interactable "${name}" in prompt:\n${prompt}`);
  return m[1]!;
}

export function click(name: string): (prompt: string) => Action {
  return (prompt) => ({ type: 'click', ref: refOf(prompt, name), intent: `click ${name}` });
}

export function charter(startPath: string, over: Partial<Charter> = {}): Charter {
  return {
    id: 'c1',
    area: 'shop',
    goal: 'Add an item to the cart and check the badge',
    type: 'happy_path',
    startPath,
    risk: 1,
    viewport: 'desktop',
    ...over,
  };
}

export async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

export async function anyFileContains(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const n = Buffer.from(needle, 'utf8');
  for (const f of await filesUnder(dir)) if ((await readFile(f)).includes(n)) hits.push(f);
  return hits;
}

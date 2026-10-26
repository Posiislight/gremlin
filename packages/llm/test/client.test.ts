import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm, loadLlmConfig, LlmError, type Usage } from '../src/index.js';

type Body = {
  model: string;
  messages: { role: string; content: unknown }[];
  tools: { function: { name: string; parameters: Record<string, unknown> } }[];
  tool_choice: unknown;
  reasoning?: { effort: string };
  provider?: unknown;
};

const schema = z.object({ reason: z.string() });

function okResponse(args: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'finish',
                  arguments: typeof args === 'string' ? args : JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, ...extra },
    }),
    { status: 200 },
  );
}

function status(code: number): Response {
  return new Response('err', { status: code });
}

function harness(
  responses: (() => Response | Promise<Response>)[],
  cfgEnv: Record<string, string> = {},
) {
  const bodies: Body[] = [];
  const usages: Usage[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    const make = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return make();
  }) as typeof fetch;
  const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k', ...cfgEnv });
  const llm = createLlm(cfg, {
    fetch: fetchStub,
    onUsage: (u) => usages.push(u),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { llm, bodies, usages, sleeps, calls: () => i };
}

const req = {
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'go' }],
  tool: { name: 'finish', description: 'done', schema },
};

describe('loadLlmConfig', () => {
  it('applies defaults and env overrides', () => {
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k', GREMLIN_MODEL_JUDGE: 'x/y' });
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.maxConcurrency).toBe(8);
    expect(cfg.roles.judge.model).toBe('x/y');
    expect(cfg.roles.navigator.model).toBe('z-ai/glm-5.3-flash');
    expect(cfg.roles.navigator.effort).toBe('low');
    expect(cfg.roles.judge.effort).toBe('high');
    expect(cfg.roles.mapper.effort).toBe('medium');
    expect(cfg.roles.healer.effort).toBe('low');
    expect(cfg.roles.reflect.effort).toBe('max');
    expect(cfg.roles.scenario.effort).toBe('medium');
  });
});

describe('callTool', () => {
  it('returns the parsed value', async () => {
    const h = harness([() => okResponse({ reason: 'ok' })]);
    const r = await h.llm.callTool('navigator', req);
    expect(r.value).toEqual({ reason: 'ok' });
    expect(r.usage.tokensIn).toBe(11);
    expect(r.usage.costUsd).toBeNull();
  });

  it('sends role model, effort, forced tool; no provider by default', async () => {
    const h = harness([() => okResponse({ reason: 'ok' })]);
    await h.llm.callTool('navigator', req);
    const b = h.bodies[0]!;
    expect(b.model).toBe('z-ai/glm-5.3-flash');
    expect(b.reasoning?.effort).toBe('low');
    expect(b.tool_choice).toEqual({ type: 'function', function: { name: 'finish' } });
    expect(b.tools[0]!.function.parameters.type).toBe('object');
    expect(b.provider).toBeUndefined();
    expect(b.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('pins provider when configured', async () => {
    const h = harness([() => okResponse({ reason: 'ok' })], { GREMLIN_PROVIDER: 'z-ai' });
    await h.llm.callTool('navigator', req);
    expect(h.bodies[0]!.provider).toEqual({ order: ['z-ai'], allow_fallbacks: false });
  });

  it('attaches images as data URLs on the last user message', async () => {
    const h = harness([() => okResponse({ reason: 'ok' })]);
    await h.llm.callTool('navigator', { ...req, images: [{ mime: 'image/png', base64: 'AAAA' }] });
    const last = h.bodies[0]!.messages.at(-1)!;
    expect(last.content).toEqual([
      { type: 'text', text: 'go' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('repairs invalid output with one extra turn', async () => {
    const h = harness([() => okResponse({ nope: 1 }), () => okResponse({ reason: 'fixed' })]);
    const r = await h.llm.callTool('navigator', req);
    expect(r.value).toEqual({ reason: 'fixed' });
    expect(h.calls()).toBe(2);
    const last = h.bodies[1]!.messages.at(-1)!;
    expect(String(last.content)).toContain('reason');
    expect(last.role).toBe('user');
    expect(h.usages).toHaveLength(1);
  });

  it('rejects invalid_output after two bad outputs', async () => {
    const h = harness([() => okResponse({ nope: 1 })]);
    await expect(h.llm.callTool('navigator', req)).rejects.toMatchObject({
      name: 'LlmError',
      code: 'invalid_output',
    });
    expect(h.calls()).toBe(2);
  });

  it('rejects no_tool_call when the model returns no tool call', async () => {
    const h = harness([
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
          status: 200,
        }),
    ]);
    const p = h.llm.callTool('navigator', req);
    await expect(p).rejects.toBeInstanceOf(LlmError);
    await expect(p).rejects.toMatchObject({ code: 'no_tool_call' });
  });

  it('retries 429 twice then succeeds', async () => {
    const h = harness([() => status(429), () => status(429), () => okResponse({ reason: 'ok' })]);
    const r = await h.llm.callTool('navigator', req);
    expect(r.value.reason).toBe('ok');
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it('rejects http after 4 consecutive 500s', async () => {
    const h = harness([() => status(500)]);
    await expect(h.llm.callTool('navigator', req)).rejects.toMatchObject({ code: 'http' });
    expect(h.calls()).toBe(4);
  });

  it('does not retry 4xx other than 429', async () => {
    const h = harness([() => status(400)]);
    await expect(h.llm.callTool('navigator', req)).rejects.toMatchObject({ code: 'http' });
    expect(h.calls()).toBe(1);
  });

  it('maps an aborted fetch to timeout', async () => {
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k' });
    let n = 0;
    const llm = createLlm(cfg, {
      fetch: (async () => {
        n++;
        throw new DOMException('timed out', 'TimeoutError');
      }) as typeof fetch,
      sleep: async () => {},
    });
    await expect(llm.callTool('navigator', req)).rejects.toMatchObject({ code: 'timeout' });
    expect(n).toBe(4);
  });

  it('falls back to fallbackModel after primary http failure', async () => {
    const bodies: Body[] = [];
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k' });
    cfg.roles.navigator.fallbackModel = 'other/model';
    const llm = createLlm(cfg, {
      sleep: async () => {},
      fetch: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Body;
        bodies.push(b);
        return b.model === 'other/model' ? okResponse({ reason: 'fb' }) : status(503);
      }) as typeof fetch,
    });
    const r = await llm.callTool('navigator', req);
    expect(r.value.reason).toBe('fb');
    expect(r.usage.model).toBe('other/model');
    expect(bodies.at(-1)!.model).toBe('other/model');
    expect(bodies.filter((b) => b.model === 'z-ai/glm-5.3-flash')).toHaveLength(4);
  });

  it('reports usage once per successful call incl. cost', async () => {
    const h = harness([() => okResponse({ reason: 'ok' }, { cost: 0.0042 })]);
    await h.llm.callTool('judge', req);
    expect(h.usages).toHaveLength(1);
    expect(h.usages[0]).toMatchObject({
      role: 'judge',
      tokensIn: 11,
      tokensOut: 7,
      costUsd: 0.0042,
    });
  });

  it('swallows a throwing onUsage without a repair turn', async () => {
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k' });
    let n = 0;
    const llm = createLlm(cfg, {
      fetch: (async () => {
        n++;
        return okResponse({ reason: 'ok' });
      }) as typeof fetch,
      onUsage: () => {
        throw new Error('telemetry down');
      },
    });
    const r = await llm.callTool('navigator', req);
    expect(r.value).toEqual({ reason: 'ok' });
    expect(n).toBe(1);
  });

  it('wraps non-object schemas and unwraps the value', async () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('click'), id: z.number() }),
      z.object({ kind: z.literal('done') }),
    ]);
    const ureq = { ...req, tool: { name: 'finish', description: 'd', schema: union } };
    const h = harness([
      () => okResponse({ value: { kind: 'bogus' } }),
      () => okResponse({ value: { kind: 'click', id: 3 } }),
    ]);
    const r = await h.llm.callTool('navigator', ureq);
    expect(r.value).toEqual({ kind: 'click', id: 3 });
    const params = h.bodies[0]!.tools[0]!.function.parameters;
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['value']);
    expect(params.additionalProperties).toBe(false);
    expect((params.properties as Record<string, unknown>).value).toBeDefined();
    expect(h.calls()).toBe(2);
  });

  it('never exceeds maxConcurrency in flight', async () => {
    let inflight = 0;
    let max = 0;
    const cfg = loadLlmConfig({ OPENROUTER_API_KEY: 'k' });
    cfg.maxConcurrency = 2;
    const llm = createLlm(cfg, {
      fetch: (async () => {
        inflight++;
        max = Math.max(max, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
        return okResponse({ reason: 'ok' });
      }) as typeof fetch,
    });
    await Promise.all(Array.from({ length: 5 }, () => llm.callTool('navigator', req)));
    expect(max).toBe(2);
  });
});

import { z } from 'zod';
import type { LlmConfig, Role, RoleConfig } from './config.js';
import { LlmError, type Usage } from './usage.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRequest<T> {
  system: string;
  messages: ChatMessage[];
  tool: { name: string; description: string; schema: z.ZodType<T> };
  images?: { mime: string; base64: string }[];
}

export interface Llm {
  callTool<T>(role: Role, req: ToolCallRequest<T>): Promise<{ value: T; usage: Usage }>;
}

export interface LlmDeps {
  fetch?: typeof fetch;
  onUsage?: (u: Usage) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

type WireMessage = { role: string; content: unknown };

interface WireResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<R>(fn: () => Promise<R>): Promise<R> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); // hand the slot over directly
      else this.active--;
    }
  }
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

function buildMessages(
  system: string,
  messages: ChatMessage[],
  images: ToolCallRequest<unknown>['images'],
): WireMessage[] {
  const wire: WireMessage[] = [{ role: 'system', content: system }];
  const lastUser = images?.length ? messages.map((m) => m.role).lastIndexOf('user') : -1;
  messages.forEach((m, i) => {
    if (i === lastUser && images) {
      wire.push({
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mime};base64,${img.base64}` },
          })),
        ],
      });
    } else {
      wire.push({ role: m.role, content: m.content });
    }
  });
  if (images?.length && lastUser === -1) {
    wire.push({
      role: 'user',
      content: images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.base64}` },
      })),
    });
  }
  return wire;
}

export function createLlm(cfg: LlmConfig, deps: LlmDeps = {}): Llm {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sem = new Semaphore(Math.max(1, cfg.maxConcurrency));

  async function post(body: unknown): Promise<WireResponse> {
    let lastErr: LlmError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1) + Math.random() * 250);
      let res: Response;
      try {
        res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        lastErr = isTimeout(e)
          ? new LlmError('timeout', `LLM call timed out after ${TIMEOUT_MS}ms`)
          : new LlmError('http', `LLM network error: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new LlmError('http', `LLM HTTP ${res.status}`, res.status);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmError('http', `LLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }
      try {
        return (await res.json()) as WireResponse;
      } catch {
        throw new LlmError('http', 'LLM returned a non-JSON body', res.status);
      }
    }
    throw lastErr ?? new LlmError('http', 'LLM call failed');
  }

  async function callWithModel<T>(
    role: Role,
    rc: RoleConfig,
    model: string,
    req: ToolCallRequest<T>,
  ): Promise<{ value: T; usage: Usage }> {
    const raw = z.toJSONSchema(req.tool.schema) as Record<string, unknown>;
    const wrapped = raw.type !== 'object';
    const parameters = wrapped
      ? {
          type: 'object',
          properties: { value: raw },
          required: ['value'],
          additionalProperties: false,
        }
      : raw;

    const messages = buildMessages(req.system, req.messages, req.images);
    const started = now();
    let tokensIn = 0;
    let tokensOut = 0;
    let cost: number | null = null;

    for (let turn = 0; turn < 2; turn++) {
      const body: Record<string, unknown> = {
        model,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: req.tool.name,
              description: req.tool.description,
              parameters,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: req.tool.name } },
        reasoning: { effort: rc.effort },
      };
      if (cfg.provider) body.provider = { order: [cfg.provider], allow_fallbacks: false };

      const json = await post(body);
      tokensIn += json.usage?.prompt_tokens ?? 0;
      tokensOut += json.usage?.completion_tokens ?? 0;
      if (typeof json.usage?.cost === 'number') cost = (cost ?? 0) + json.usage.cost;

      const call = json.choices?.[0]?.message?.tool_calls?.[0];
      const args = call?.function?.arguments;
      if (typeof args !== 'string') {
        throw new LlmError('no_tool_call', 'model returned no tool call');
      }

      let problem: string | undefined;
      let parsedValue: { data: T } | undefined;
      try {
        const parsed: unknown = JSON.parse(args);
        const candidate = wrapped
          ? parsed !== null && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>).value
            : undefined
          : parsed;
        const result = req.tool.schema.safeParse(candidate);
        if (result.success) parsedValue = { data: result.data };
        else problem = z.prettifyError(result.error);
      } catch (e) {
        problem = `arguments were not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (parsedValue) {
        const usage: Usage = {
          role,
          model,
          tokensIn,
          tokensOut,
          latencyMs: now() - started,
          costUsd: cost,
        };
        try {
          deps.onUsage?.(usage);
        } catch {
          // Telemetry must never fail an otherwise successful LLM call.
        }
        return { value: parsedValue.data, usage };
      }

      if (turn === 1) {
        throw new LlmError('invalid_output', `tool arguments failed validation: ${problem}`);
      }
      messages.push({ role: 'assistant', content: args });
      messages.push({
        role: 'user',
        content:
          `Your last tool call for "${req.tool.name}" was invalid:\n${problem}\n` +
          `Call the tool again with corrected arguments.`,
      });
    }
    throw new LlmError('invalid_output', 'unreachable');
  }

  return {
    callTool<T>(role: Role, req: ToolCallRequest<T>) {
      const rc = cfg.roles[role];
      return sem.run(async () => {
        try {
          return await callWithModel(role, rc, rc.model, req);
        } catch (e) {
          if (
            rc.fallbackModel &&
            e instanceof LlmError &&
            (e.code === 'http' || e.code === 'timeout')
          ) {
            return await callWithModel(role, rc, rc.fallbackModel, req);
          }
          throw e;
        }
      });
    },
  };
}

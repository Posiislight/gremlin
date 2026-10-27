import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { FsStorage } from '@gremlin/storage';
import { LlmError } from '@gremlin/llm';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { charter, click, fakeLlm, finish, type ScriptItem } from './loopHarness.js';
import { runAgent, type RunAgentOpts } from '../src/loop.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let work: string;
let runs = 0;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  work = await mkdtemp(join(tmpdir(), 'gremlin-loopbad-'));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

function opts(script: ScriptItem[]): { o: RunAgentOpts; storage: FsStorage } {
  const storage = new FsStorage(join(work, 'storage'));
  const runId = `r${++runs}`;
  return {
    storage,
    o: {
      browser,
      baseUrl: server.url,
      charter: charter('/cart.html'),
      llm: fakeLlm(script),
      storage,
      runId,
      keyPrefix: `scans/s1/runs/${runId}`,
      secrets: {},
      allowedActions: 'read_only',
    },
  };
}

describe('runAgent: bad model output', () => {
  it('invalid_output once, then finish -> model_error step, finished', async () => {
    const { o } = opts([new LlmError('invalid_output', 'tool arguments failed validation: bad'), finish()]);
    const r = await runAgent(o);
    expect(r.status).toBe('finished');
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]!.outcome).toBe('model_error');
    expect(r.steps[0]!.error).toMatch(/failed validation/);
    expect(r.steps[1]!.action.type).toBe('finish');
  });

  it('click on a ref that does not exist -> error step, loop continues', async () => {
    const { o } = opts([{ type: 'click', ref: 'e999', intent: 'made up' }, click('Add to cart'), finish()]);
    const r = await runAgent(o);
    expect(r.status).toBe('finished');
    expect(r.steps.map((s) => s.outcome)).toEqual(['error', 'ok', 'ok']);
    expect(r.steps[0]!.error).toMatch(/ref e999 not found/);
  });

  it('the model error is shown to the model on the next step', async () => {
    const llm = fakeLlm([{ type: 'click', ref: 'e999', intent: 'made up' }, finish()]);
    const { o } = opts([]);
    await runAgent({ ...o, llm });
    expect(llm.prompts[1]).toMatch(/ref e999 not found/);
  });

  it('a non-recoverable LLM error ends the run with status error; steps so far and artifacts persist', async () => {
    const { o, storage } = opts([click('Add to cart'), new LlmError('http', 'LLM HTTP 401: unauthorized', 401)]);
    const r = await runAgent(o);
    expect(r.status).toBe('error');
    expect(r.steps).toHaveLength(1);
    expect(await storage.exists(r.artifacts.timelineKey)).toBe(true);
    expect(await storage.exists(r.artifacts.traceKey)).toBe(true);
  });
});

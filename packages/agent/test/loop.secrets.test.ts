import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { FsStorage } from '@gremlin/storage';
import { launchBrowser } from './browser.js';
import { startFixtureServer } from './server.js';
import { anyFileContains, charter, fakeLlm, finish, refOf } from './loopHarness.js';
import { runAgent, type AgentEvent } from '../src/loop.js';

const SECRETS = { username: 'ann@x.io', password: 'S3cret!x' };

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let work: string;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await launchBrowser();
  work = await mkdtemp(join(tmpdir(), 'gremlin-loopsec-'));
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

describe('runAgent: secrets', () => {
  it('typed credentials never reach prompts, persisted steps, events or stored artifacts', async () => {
    const storageDir = join(work, 'storage');
    const storage = new FsStorage(storageDir);
    const llm = fakeLlm([
      (p) => ({ type: 'type', ref: refOf(p, 'Email'), text: '{{username}}', intent: 'enter email' }),
      (p) => ({ type: 'type', ref: refOf(p, 'Password'), text: '{{password}}', submit: true, intent: 'enter password' }),
      // the model "echoes" what it saw on the page (the email field's value) in its report
      (p) => ({
        type: 'report_bug',
        title: 'Echo',
        expected: 'x',
        actual: p.slice(p.indexOf('<<<PAGE_CONTENT'), p.indexOf('<<<PAGE_CONTENT') + 1500),
        severityHint: 'P3',
        intent: 'echo',
      }),
      finish(),
    ]);
    const events: AgentEvent[] = [];
    const r = await runAgent({
      browser,
      baseUrl: server.url,
      charter: charter('/form.html', { goal: 'Sign up' }),
      llm,
      storage,
      runId: 'sec1',
      keyPrefix: 'scans/s1/runs/sec1',
      secrets: SECRETS,
      allowedActions: 'read_only',
      onEvent: (e) => events.push(e),
    });
    expect(r.status).toBe('finished');
    expect(r.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
    // the model saw placeholders and the page field values masked
    expect(llm.prompts.join('\n')).toContain('{{password}}');
    for (const p of [...llm.prompts, ...llm.systems]) {
      expect(p).not.toContain(SECRETS.password);
      expect(p).not.toContain(SECRETS.username);
    }
    // persisted steps keep the placeholder form
    expect(r.steps[1]!.action).toMatchObject({ type: 'type', text: '{{password}}' });
    const persisted = JSON.stringify({ steps: r.steps, candidates: r.candidates, expectations: r.expectations, events });
    expect(persisted).not.toContain(SECRETS.password);
    expect(persisted).not.toContain(SECRETS.username);
    // every stored artifact byte stream
    expect(await anyFileContains(storageDir, SECRETS.password)).toEqual([]);
  });
});

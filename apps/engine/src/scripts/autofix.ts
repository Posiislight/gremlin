/**
 * Self-fixing loop for one Gremlin finding.
 *   pnpm --filter @gremlin/engine autofix <findingId> --repro-cmd "<cmd>" [--test-cmd "<cmd>"] [--yes]
 * Needs a running engine (.env.demo), `claude` and `gh` on PATH. Nothing is pushed until every gate passes
 * and you approve (or pass --yes).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseEnv, parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { extractRepro, runAutofix, type AutofixIo } from '../autofix.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'repro-cmd': { type: 'string' },
    'repro-file': { type: 'string', default: 'tests/gremlin-repro.spec.ts' },
    'test-cmd': { type: 'string', default: 'pnpm test' },
    attempts: { type: 'string', default: '3' },
    yes: { type: 'boolean', default: false },
  },
});
const findingId = positionals[0];
if (!findingId || !values['repro-cmd']) {
  console.error('usage: autofix <findingId> --repro-cmd "<command that exits 0 when fixed>" [--test-cmd] [--repro-file] [--attempts N] [--yes]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '../../../..');
const env = parseEnv(readFileSync(resolve(root, '.env.demo'), 'utf8'));
const base = env.GREMLIN_ENGINE_URL!;
const headers = { authorization: `Bearer ${env.GREMLIN_API_KEY}` };

const sh = (cwd: string, cmd: string, args: string[], input?: string) =>
  new Promise<{ code: number; output: string }>((res) => {
    const p = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32', timeout: 15 * 60_000 }, (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}` }));
    if (input !== undefined) p.stdin?.end(input);
  });
const shell = (cwd: string, line: string) => sh(cwd, line, []);
const must = async (r: Promise<{ code: number; output: string }>) => {
  const x = await r;
  if (x.code !== 0) throw new Error(x.output.slice(-800));
  return x.output;
};

const res = await fetch(`${base}/v1/findings/${encodeURIComponent(findingId)}/prompt`, { headers });
if (!res.ok) throw new Error(`finding prompt: HTTP ${res.status}`);
const { prompt } = (await res.json()) as { prompt: string };
const finding = (await (await fetch(`${base}/v1/findings/${encodeURIComponent(findingId)}`, { headers })).json()) as { title: string };
const repro = extractRepro(prompt);
if (!repro) throw new Error('fix prompt has no generated Playwright reproduction');

let tmp = '';
const io: AutofixIo = {
  async prepare(branch) {
    tmp = await mkdtemp(join(tmpdir(), 'gremlin-fix-'));
    const dir = join(tmp, 'wt');
    await must(sh(root, 'git', ['worktree', 'add', '-B', branch, dir, 'HEAD']));
    return dir;
  },
  async fix(dir, p) {
    const r = await sh(dir, 'claude', ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Grep,Glob,Bash'], p);
    if (r.code !== 0) throw new Error(`coding agent failed: ${r.output.slice(-400)}`);
  },
  async writeRepro(dir, source) {
    const f = join(dir, values['repro-file']!);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, source);
  },
  run: (dir, cmd) => shell(dir, cmd === 'tests' ? values['test-cmd']! : cmd === 'repro' ? values['repro-cmd']! : cmd),
  async diff(dir) {
    await sh(dir, 'git', ['add', '-A']);
    return (await sh(dir, 'git', ['diff', '--cached', 'HEAD'])).output;
  },
  async review(dir, diff, title) {
    const r = await sh(dir, 'claude', ['-p', '--permission-mode', 'plan'],
      `You are a strict, independent code reviewer. A bug "${title}" was auto-fixed. Reply with exactly "APPROVE: <reason>" only if the diff fixes the root cause without hiding errors, weakening tests, or unrelated changes; otherwise "REJECT: <reason>".\n\n${diff.slice(0, 60_000)}`);
    return r.output.trim();
  },
  async approve(summary) {
    console.info(`\n${summary}\n`);
    if (values.yes) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question('All gates passed. Approve and open a PR? [y/N] ');
    rl.close();
    return /^y/i.test(a);
  },
  async openPr(dir, branch, title, body) {
    await must(sh(dir, 'git', ['commit', '-m', `${title}\n\nGremlin finding ${findingId}`]));
    await must(sh(dir, 'git', ['push', '-u', 'origin', branch]));
    return (await must(sh(dir, 'gh', ['pr', 'create', '--title', title, '--body', body]))).trim();
  },
  async report(outcome) {
    const client = new Client({ name: 'gremlin-autofix', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
      await client.callTool({ name: 'report_fix_outcome', arguments: { findingId, promptVariant: 'default', outcome } });
    } catch (e) {
      console.warn(`could not report outcome: ${(e as Error).message}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  },
  async cleanup(dir) {
    await sh(root, 'git', ['worktree', 'remove', '--force', dir]);
    if (tmp) await rm(tmp, { recursive: true, force: true });
  },
  log: (l) => console.info(l),
};

const result = await runAutofix(io, {
  findingId, title: finding.title, prompt,
  testCmd: 'tests', reproCmd: 'repro', maxAttempts: Number(values.attempts),
}, repro);
console.info(result.status === 'pr_opened' ? `PR: ${result.url}` : `${result.status}: ${result.reason}`);
process.exit(result.status === 'pr_opened' ? 0 : 1);

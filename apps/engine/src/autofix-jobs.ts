import { spawn, type ChildProcess } from 'node:child_process';

export type AutofixJob = { status: 'running' | 'pr_opened' | 'failed'; log: string[]; prUrl: string | null; startedAt: number };

const jobs = new Map<string, AutofixJob>();
const MAX_LOG = 200;

export const getAutofixJob = (findingId: string): AutofixJob | undefined => jobs.get(findingId);

/** Start the autofix CLI for a finding unless one is already running. The caller has verified ownership. */
export function startAutofixJob(findingId: string, opts: { reproCmd: string; cwd: string; spawnFn?: typeof spawn }): AutofixJob {
  const existing = jobs.get(findingId);
  if (existing?.status === 'running') return existing;
  const job: AutofixJob = { status: 'running', log: [], prUrl: null, startedAt: Date.now() };
  jobs.set(findingId, job);
  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      job.log.push(line.slice(0, 500));
      const m = /^PR: (https?:\/\/\S+)/.exec(line);
      if (m) job.prUrl = m[1]!;
    }
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  };
  // Clicking the button in the dashboard is the human approval, hence --yes. Args are passed unshelled.
  const child: ChildProcess = (opts.spawnFn ?? spawn)('pnpm', ['--filter', '@gremlin/engine', 'autofix', findingId, '--yes', '--repro-cmd', opts.reproCmd], {
    cwd: opts.cwd,
    shell: process.platform === 'win32',
  });
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('error', (e) => {
    job.log.push(`failed to start: ${e.message}`);
    job.status = 'failed';
  });
  child.on('close', (code) => {
    job.status = code === 0 && job.prUrl ? 'pr_opened' : 'failed';
  });
  return job;
}

/**
 * Self-improving fix loop: finding -> coding agent fixes in an isolated worktree -> project tests ->
 * reproduction test -> independent review -> human approval -> PR. Every side effect is injected so the
 * gating logic is testable without git, an LLM or a browser.
 */

export type Gate = { name: string; ok: boolean; detail: string };

export type AutofixIo = {
  /** Create an isolated branch/worktree and return its directory. */
  prepare(branch: string): Promise<string>;
  /** Run the coding agent in `dir` with `prompt`. */
  fix(dir: string, prompt: string): Promise<void>;
  /** Write the reproduction test into the worktree and return the command that runs it. */
  writeRepro(dir: string, source: string): Promise<void>;
  /** Run a shell command in `dir`. */
  run(dir: string, cmd: string): Promise<{ code: number; output: string }>;
  /** Unified diff of everything changed in the worktree vs its base. */
  diff(dir: string): Promise<string>;
  /** Independent reviewer: returns its verdict text, which must start with APPROVE to pass. */
  review(dir: string, diff: string, finding: string): Promise<string>;
  /** Human (or --yes) approval. */
  approve(summary: string): Promise<boolean>;
  /** Commit, push and open the PR; returns its URL. */
  openPr(dir: string, branch: string, title: string, body: string): Promise<string>;
  /** Close the loop with the engine (report_fix_outcome). Best effort. */
  report(outcome: 'fixed' | 'not_fixed' | 'abandoned'): Promise<void>;
  /** Remove the worktree when nothing was shipped. */
  cleanup(dir: string): Promise<void>;
  log(line: string): void;
};

export type AutofixInput = {
  findingId: string;
  title: string;
  prompt: string;
  testCmd: string;
  /** Command that runs the written reproduction test. Receives nothing; must exit 0 only when the bug is gone. */
  reproCmd: string;
  maxAttempts: number;
};

export type AutofixResult =
  | { status: 'pr_opened'; url: string; gates: Gate[]; attempts: number }
  | { status: 'rejected' | 'failed'; reason: string; gates: Gate[]; attempts: number };

const TEST_FILE = /(^|\/)(tests?|__tests__|e2e)\/|\.(spec|test)\.[cm]?[jt]sx?$/;

/** Fixes must not make the safety net weaker: no deleted/skipped tests, no removed assertions. */
export function weakenedTests(diff: string): string[] {
  const problems: string[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('--- ') && line.endsWith('/dev/null')) continue;
    else if (line.startsWith('+++ /dev/null')) continue;
    if (!TEST_FILE.test(file)) continue;
    if (/^-\s*.*\bexpect\(/.test(line) && !line.startsWith('---')) problems.push(`${file}: removed assertion`);
    if (/^\+.*\b(test|it|describe)\.(skip|fixme)\b|^\+.*\bretries\s*:/.test(line)) problems.push(`${file}: skipped test or added retries`);
  }
  return [...new Set(problems)];
}

export function repairPrompt(base: string, failures: Gate[]): string {
  const why = failures.map((g) => `- ${g.name}: ${g.detail.slice(-1500)}`).join('\n');
  return `${base}\n\nYour previous attempt failed these checks. Fix the root cause; never weaken or skip tests.\n${why}`;
}

export async function runAutofix(io: AutofixIo, input: AutofixInput, reproSource: string): Promise<AutofixResult> {
  const branch = `gremlin/fix-${input.findingId.slice(0, 12)}`;
  const dir = await io.prepare(branch);
  let gates: Gate[] = [];
  let prompt = input.prompt;
  let shipped = false;
  try {
    for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
      io.log(`attempt ${attempt}/${input.maxAttempts}: coding agent is fixing "${input.title}"`);
      await io.fix(dir, prompt);
      await io.writeRepro(dir, reproSource);
      const diff = await io.diff(dir);
      gates = [];
      if (!diff.trim()) {
        gates.push({ name: 'change', ok: false, detail: 'agent produced no changes' });
      } else {
        const weak = weakenedTests(diff);
        gates.push({ name: 'tests-not-weakened', ok: !weak.length, detail: weak.join('; ') || 'ok' });
        const tests = await io.run(dir, input.testCmd);
        gates.push({ name: 'project-tests', ok: tests.code === 0, detail: tests.output });
        const repro = await io.run(dir, input.reproCmd);
        gates.push({ name: 'reproduction-passes', ok: repro.code === 0, detail: repro.output });
        if (gates.every((g) => g.ok)) {
          const verdict = await io.review(dir, diff, input.title);
          gates.push({ name: 'independent-review', ok: /^\s*APPROVE\b/i.test(verdict), detail: verdict });
        }
      }
      for (const g of gates) io.log(`  ${g.ok ? 'PASS' : 'FAIL'} ${g.name}`);
      const failed = gates.filter((g) => !g.ok);
      if (!failed.length) {
        const summary = `Finding ${input.findingId}: ${input.title}\n${gates.map((g) => `  PASS ${g.name}`).join('\n')}`;
        if (!(await io.approve(summary))) {
          await io.report('abandoned');
          return { status: 'rejected', reason: 'approval declined', gates, attempts: attempt };
        }
        const body = `## Gremlin auto-fix\n\nFixes finding \`${input.findingId}\`: **${input.title}**\n\n### Gates\n${gates
          .map((g) => `- [x] ${g.name}`)
          .join('\n')}\n\nThe reproduction test generated from the recorded failure now passes.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
        const url = await io.openPr(dir, branch, `fix: ${input.title}`.slice(0, 120), body);
        shipped = true;
        await io.report('fixed');
        return { status: 'pr_opened', url, gates, attempts: attempt };
      }
      prompt = repairPrompt(input.prompt, failed);
    }
    await io.report('not_fixed');
    return { status: 'failed', reason: `gates still failing after ${input.maxAttempts} attempts`, gates, attempts: input.maxAttempts };
  } finally {
    if (!shipped) await io.cleanup(dir);
  }
}

/** First ```ts fenced block that contains a Playwright `test(` — the generated reproduction. */
export function extractRepro(prompt: string): string | null {
  for (const m of prompt.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)) if (/\btest\s*\(/.test(m[1]!)) return m[1]!;
  return null;
}

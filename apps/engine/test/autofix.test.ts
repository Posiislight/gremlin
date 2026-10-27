import { describe, expect, it, vi } from 'vitest';
import { extractRepro, runAutofix, weakenedTests, type AutofixIo } from '../src/autofix.js';

const input = { findingId: 'abcdef1234567890', title: 'Second save fails', prompt: 'fix it', testCmd: 'tests', reproCmd: 'repro', maxAttempts: 2 };

function makeIo(over: Partial<AutofixIo> = {}): AutofixIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prepare: async (b) => (calls.push(`prepare:${b}`), '/wt'),
    fix: async (_d, p) => void calls.push(`fix:${p.length > 6 ? 'repair' : 'first'}`),
    writeRepro: async () => void calls.push('repro'),
    run: async () => ({ code: 0, output: 'ok' }),
    diff: async () => '+++ b/src/cart.ts\n+fixed\n',
    review: async () => 'APPROVE: root cause fixed',
    approve: async () => true,
    openPr: async () => 'https://github.com/o/r/pull/1',
    report: async (o) => void calls.push(`report:${o}`),
    cleanup: async () => void calls.push('cleanup'),
    log: () => undefined,
    ...over,
  };
}

describe('weakenedTests', () => {
  it('flags removed assertions and skipped tests in test files only', () => {
    const diff = ['+++ b/tests/cart.spec.ts', '-  expect(a).toBe(1);', '+  test.skip("x")', '+++ b/src/a.ts', '-  expect(b)'].join('\n');
    expect(weakenedTests(diff)).toEqual(['tests/cart.spec.ts: removed assertion', 'tests/cart.spec.ts: skipped test or added retries']);
  });
});

describe('extractRepro', () => {
  it('returns the fenced block containing a Playwright test', () => {
    expect(extractRepro('x\n```ts\nconst a=1\n```\n```ts\ntest("a",()=>{})\n```')).toContain('test(');
    expect(extractRepro('no code')).toBeNull();
  });
});

describe('runAutofix', () => {
  it('opens a PR only after every gate and approval pass, then reports fixed', async () => {
    const io = makeIo();
    const r = await runAutofix(io, input, 'src');
    expect(r).toMatchObject({ status: 'pr_opened', url: 'https://github.com/o/r/pull/1', attempts: 1 });
    expect(io.calls).toContain('report:fixed');
    expect(io.calls).not.toContain('cleanup');
  });

  it('retries with the failure fed back, then succeeds', async () => {
    let n = 0;
    const io = makeIo({ run: async (_d, cmd) => ({ code: cmd === 'repro' && n++ === 0 ? 1 : 0, output: 'boom' }) });
    const r = await runAutofix(io, input, 'src');
    expect(r.status).toBe('pr_opened');
    expect(r.attempts).toBe(2);
    expect(io.calls.filter((c) => c.startsWith('fix:'))).toEqual(['fix:first', 'fix:repair']);
  });

  it('gives up without a PR when gates keep failing', async () => {
    const openPr = vi.fn();
    const io = makeIo({ run: async () => ({ code: 1, output: 'red' }), openPr });
    const r = await runAutofix(io, input, 'src');
    expect(r.status).toBe('failed');
    expect(openPr).not.toHaveBeenCalled();
    expect(io.calls).toEqual(expect.arrayContaining(['report:not_fixed', 'cleanup']));
  });

  it('refuses a fix that weakens tests even if they pass', async () => {
    const openPr = vi.fn();
    const io = makeIo({ diff: async () => '+++ b/tests/a.spec.ts\n-  expect(x).toBe(1);\n', openPr });
    expect((await runAutofix(io, input, 'src')).status).toBe('failed');
    expect(openPr).not.toHaveBeenCalled();
  });

  it('blocks on reviewer rejection and on declined approval', async () => {
    const rev = makeIo({ review: async () => 'REJECT: hides the error' });
    expect((await runAutofix(rev, input, 'src')).status).toBe('failed');
    const openPr = vi.fn();
    const no = makeIo({ approve: async () => false, openPr });
    expect(await runAutofix(no, input, 'src')).toMatchObject({ status: 'rejected' });
    expect(openPr).not.toHaveBeenCalled();
    expect(no.calls).toContain('cleanup');
  });

  it('treats an empty diff as a failure', async () => {
    const r = await runAutofix(makeIo({ diff: async () => '' }), input, 'src');
    expect(r.status).toBe('failed');
  });
});

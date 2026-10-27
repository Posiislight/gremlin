import type { Action, Locator } from '@gremlin/contract';

export interface PromptStep {
  n: number;
  action: Action;
  locator: Locator | null;
  intent: string | null;
}

export interface PromptFinding {
  id: string;
  title: string;
  priority: string;
  expected: string;
  actual: string;
  url: string | null;
  oracle: string | null;
}

/** Masks anything that looks like a credential before it leaves the engine. */
export function scrub(text: string): string {
  return text
    .replace(/\bgrm_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b(sk|pk|ghp|xox[bap])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["'\s:=]+)[^\s"',}]{4,}/gi, '$1[REDACTED]');
}

export function replayUrl(base: string, runId: string, stepN: number, findingId: string): string {
  return `${base.replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}?step=${stepN}&finding=${encodeURIComponent(findingId)}`;
}

const q = (s: string) => JSON.stringify(s);

function locatorExpr(l: Locator | null): string {
  if (!l) return 'page.locator("body")';
  if (l.testId) return `page.getByTestId(${q(l.testId)})`;
  if (l.role) return `page.getByRole(${q(l.role.role)}, { name: ${q(l.role.name)} })`;
  if (l.label) return `page.getByLabel(${q(l.label)})`;
  if (l.placeholder) return `page.getByPlaceholder(${q(l.placeholder)})`;
  if (l.text) return `page.getByText(${q(l.text)})`;
  return `page.locator(${q(l.css)})`;
}

/** Best-effort Playwright reproduction from the recorded steps (secrets typed by the agent stay as placeholders). */
export function playwrightTest(finding: PromptFinding, steps: PromptStep[], baseUrl: string | null): string {
  const lines: string[] = [];
  for (const s of steps) {
    const a = s.action;
    const loc = locatorExpr(s.locator);
    switch (a.type) {
      case 'goto':
        lines.push(`  await page.goto(new URL(${q(a.path)}, baseURL).toString());`);
        break;
      case 'click':
        lines.push(`  await ${loc}.click();`);
        break;
      case 'type':
        lines.push(`  await ${loc}.fill(${q(scrub(a.text))});`);
        if (a.submit) lines.push(`  await ${loc}.press('Enter');`);
        break;
      case 'select':
        lines.push(`  await ${loc}.selectOption(${q(a.option)});`);
        break;
      case 'press':
        lines.push(`  await page.keyboard.press(${q(a.key)});`);
        break;
      case 'hover':
        lines.push(`  await ${loc}.hover();`);
        break;
      case 'back':
        lines.push('  await page.goBack();');
        break;
      case 'refresh':
        lines.push('  await page.reload();');
        break;
      default:
        break;
    }
  }
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${q(`${finding.id}: ${finding.title}`)}, async ({ page, baseURL: configured }) => {`,
    `  const baseURL = configured ?? ${q(baseUrl ?? 'http://localhost:3000')};`,
    '  const errors: string[] = [];',
    "  page.on('pageerror', (e) => errors.push(e.message));",
    ...lines,
    '  // Expected behaviour (must pass once fixed):',
    `  //   ${scrub(finding.expected).replace(/\n/g, ' ')}`,
    '  expect(errors).toEqual([]);',
    '});',
    '',
  ].join('\n');
}

export function fixPrompt(args: {
  finding: PromptFinding;
  steps: PromptStep[];
  signals: unknown[];
  replay: string | null;
  test: string;
}): string {
  const { finding: f, steps, signals, replay, test } = args;
  const repro = steps.length
    ? steps.map((s) => `${s.n}. ${scrub(s.intent ?? s.action.intent ?? s.action.type)}`).join('\n')
    : '(no recorded steps)';
  const sig = signals.length ? signals.map((s) => `- ${scrub(JSON.stringify(s))}`).join('\n') : '- none captured';
  return scrub(
    [
      `# Fix: ${f.title}`,
      `Priority: ${f.priority}   Finding: ${f.id}${f.url ? `   Page: ${f.url}` : ''}`,
      '',
      '## Expected',
      f.expected,
      '',
      '## Actual',
      f.actual,
      '',
      '## Reproduction steps',
      repro,
      '',
      ...(replay ? ['## Replay', replay, ''] : []),
      '## Raw signals',
      sig,
      '',
      '## Playwright test (currently failing)',
      '```ts',
      test.trimEnd(),
      '```',
      '',
      '## Task',
      `Make this test pass without weakening or deleting it, fixing the root cause in the app code. Then deploy or preview the change and call the Gremlin tool verify_fix with findingId "${f.id}" and the preview URL. Afterwards call report_fix_outcome.`,
    ].join('\n'),
  );
}

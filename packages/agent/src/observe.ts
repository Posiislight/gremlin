import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { normalizePath, stateHash } from './url.js';

export type Interactable = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled: boolean;
  section?: string;
  inViewport: boolean;
};

export type Observation = {
  url: string;
  path: string;
  stateHash: string;
  title: string;
  interactables: Interactable[];
  text: string;
  alerts: string[];
  rendered: string;
  tokenEstimate: number;
};

export type ObserveOptions = {
  maxInteractables?: number;
  maxTextTokens?: number;
  previous?: Observation;
};

type Raw = {
  title: string;
  items: Interactable[];
  alerts: string[];
  headings: string[];
  text: string;
  total: number;
};

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Read once at module load; a function expression evaluated in the page.
const INJECT_SRC = readFileSync(new URL('./inject/observe.js', import.meta.url), 'utf8');

function truncateToTokens(s: string, tokens: number): string {
  const max = Math.max(0, tokens * 4);
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function renderLine(i: Interactable): string {
  let line = `${i.ref} ${i.role} "${i.name.replace(/"/g, "'")}"`;
  if (i.disabled) line += ' [disabled]';
  if (i.value !== undefined) line += ` [value="${i.value.replace(/"/g, "'")}"]`;
  if (i.section) line += ` (section: ${i.section})`;
  return line;
}

export async function observe(page: Page, opts: ObserveOptions = {}): Promise<Observation> {
  const maxInteractables = opts.maxInteractables ?? 150;
  const maxTextTokens = opts.maxTextTokens ?? 1500;
  const raw = (await page.evaluate(`(${INJECT_SRC})(${JSON.stringify({
    max: maxInteractables,
    maxTextChars: maxTextTokens * 4,
  })})`)) as Raw;

  const url = page.url();
  const path = normalizePath(url);
  const hash = stateHash(path, raw.items);

  const headings = raw.headings.length ? `Headings: ${raw.headings.join(' | ')}` : '';
  const textBudget = Math.max(0, maxTextTokens - estimateTokens(headings));
  const text = truncateToTokens(raw.text, textBudget);

  const unchanged = opts.previous !== undefined && opts.previous.stateHash === hash;
  const n = raw.items.length;
  const more = raw.total > n ? ` (showing ${n} of ${raw.total})` : '';

  const parts = [`URL: ${url}`, `Title: ${raw.title}`];
  parts.push(
    unchanged
      ? `Interactables: (unchanged, ${n} elements)`
      : `Interactables (${n})${more}:\n${n ? raw.items.map(renderLine).join('\n') : '(none)'}`,
  );
  if (raw.alerts.length) parts.push(`Alerts:\n${raw.alerts.map((a) => `- ${a}`).join('\n')}`);
  if (headings) parts.push(headings);
  if (text) parts.push(`Text: ${text}`);
  const rendered = parts.join('\n');

  return {
    url,
    path,
    stateHash: hash,
    title: raw.title,
    interactables: raw.items,
    text,
    alerts: raw.alerts,
    rendered,
    tokenEstimate: estimateTokens(rendered),
  };
}

import type { Priority, Step } from '../types';

export function formatMs(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const r = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

/** Compact: 840ms, 12.4s, 3m 05s */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatPercent(x: number | null | undefined, digits = 0): string {
  return x == null ? '-' : `${(x * 100).toFixed(digits)}%`;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '-';
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '-';
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Path + query only, truncated in the middle. */
export function shortUrl(url: string, max = 56): string {
  let out = url;
  try {
    const u = new URL(url);
    out = u.pathname + u.search;
  } catch {
    /* relative or malformed: show as is */
  }
  if (out.length <= max) return out;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.6);
  return out.slice(0, head) + '…' + out.slice(out.length - (keep - head));
}

export function stepVerb(step: Pick<Step, 'action'>): string {
  const a = step.action;
  switch (a.type) {
    case 'goto':
      return `goto ${a.path}`;
    case 'type':
      return `type "${a.text.length > 24 ? a.text.slice(0, 23) + '…' : a.text}"`;
    case 'press':
      return `press ${a.key}`;
    case 'scroll':
      return `scroll ${a.direction}`;
    case 'expect':
      return `expect "${a.statement}"`;
    case 'report_bug':
      return `report_bug "${a.title}"`;
    case 'finish':
      return 'finish';
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'select':
      return `select "${a.option}"`;
    case 'back':
      return 'back';
    case 'refresh':
      return 'refresh';
    default:
      return a.type;
  }
}

/** Short target label: the locator's most human name, else the ref. */
export function stepTarget(step: Pick<Step, 'action' | 'locator'>): string | null {
  const l = step.locator;
  if (l) return l.role?.name || l.label || l.text || l.placeholder || l.testId || l.css;
  const a = step.action;
  return 'ref' in a ? a.ref : null;
}

export type StepGlyph = 'ok' | 'fail' | 'warn' | 'idle';
export function stepGlyph(step: Pick<Step, 'outcome' | 'signals'>): StepGlyph {
  if (step.outcome === 'error' || step.outcome === 'model_error') return 'fail';
  if (step.outcome === 'blocked_by_policy' || step.outcome === 'noop') return 'warn';
  const bad = step.signals.some(
    (s) =>
      s.kind === 'pageerror' ||
      (s.kind === 'console' && s.level === 'error') ||
      (s.kind === 'network' && (s.status == null ? !!s.failure : s.status >= 400)),
  );
  return bad ? 'warn' : 'ok';
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const priorityRank = (p: Priority): number => RANK[p];

export function groupByPriority<T extends { priority: Priority }>(items: T[]): { priority: Priority; items: T[] }[] {
  const out: { priority: Priority; items: T[] }[] = [];
  for (const p of ['P0', 'P1', 'P2', 'P3'] as const) {
    const g = items.filter((i) => i.priority === p);
    if (g.length) out.push({ priority: p, items: g });
  }
  return out;
}

export function httpTone(
  status: number | null | undefined,
  failure?: string,
): 'ok' | 'redirect' | 'client' | 'server' | 'failed' {
  if (status == null) return failure ? 'failed' : 'ok';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  if (status >= 300) return 'redirect';
  return 'ok';
}

import type { Signal } from '../types';
import { clamp } from './sync';

export type ConsoleLevel = 'error' | 'warning';
export type ConsoleEntry = { tMs: number; level: ConsoleLevel; text: string; location?: string; stack?: string; pageError: boolean };

export function consoleEntries(signals: readonly Signal[]): ConsoleEntry[] {
  const out: ConsoleEntry[] = [];
  for (const s of signals) {
    if (s.kind === 'console')
      out.push({ tMs: s.tMs, level: s.level, text: s.text, ...(s.location ? { location: s.location } : {}), pageError: false });
    else if (s.kind === 'pageerror')
      out.push({ tMs: s.tMs, level: 'error', text: s.message, ...(s.stack ? { stack: s.stack } : {}), pageError: true });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

export function filterConsole(entries: readonly ConsoleEntry[], levels: ReadonlySet<ConsoleLevel>, query = ''): ConsoleEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) => levels.has(e.level) && (!q || e.text.toLowerCase().includes(q) || (e.location ?? '').toLowerCase().includes(q)),
  );
}

export type NetworkEntry = {
  tMs: number;
  method: string;
  url: string;
  status: number | null;
  failure?: string;
  durationMs: number;
  resourceType: string;
  bodyKey?: string;
  failed: boolean;
};

export function networkEntries(signals: readonly Signal[]): NetworkEntry[] {
  const out: NetworkEntry[] = [];
  for (const s of signals) {
    if (s.kind !== 'network') continue;
    out.push({
      tMs: s.tMs,
      method: s.method,
      url: s.url,
      status: s.status,
      durationMs: s.durationMs,
      resourceType: s.resourceType,
      ...(s.failure ? { failure: s.failure } : {}),
      ...(s.bodyKey ? { bodyKey: s.bodyKey } : {}),
      failed: s.status == null ? !!s.failure : s.status >= 400,
    });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/** Waterfall bar geometry (percent of the visible window). */
export function waterfall(entries: readonly NetworkEntry[]): { left: number; width: number }[] {
  if (entries.length === 0) return [];
  const start = Math.min(...entries.map((e) => e.tMs));
  const end = Math.max(...entries.map((e) => e.tMs + Math.max(1, e.durationMs)));
  const span = Math.max(1, end - start);
  return entries.map((e) => ({
    left: clamp(((e.tMs - start) / span) * 100, 0, 100),
    width: clamp((Math.max(1, e.durationMs) / span) * 100, 1.5, 100),
  }));
}

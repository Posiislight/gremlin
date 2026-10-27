import { createHash } from 'node:crypto';
import type { Candidate, OracleKind, Signal, Step } from '@gremlin/contract';
import type { Observation } from '../observe.js';
import { normalizePath } from '../url.js';

/**
 * Everything an oracle needs for ONE step. `signals` must already be the signals belonging to this step
 * (the loop drains the recorder since the previous step; oracles do not window by time themselves, because
 * `Step.tMs` is a single timestamp, not a range). `step.signals` is not read.
 */
export type OracleInput = {
  step: Step;
  signals: Signal[];
  observation: Observation;
  prevObservation?: Observation;
  origin: string;
  loggedIn: boolean;
  settleCappedCount: number;
};

export type Oracle = (input: OracleInput) => Candidate[];

/** Hard cap on any page/signal-derived string stored in a Candidate (message and evidence values). */
export const MAX_ECHO = 200;

export function clip(s: string, max = MAX_ECHO): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const HEX = /\b[0-9a-f]{8,}\b/gi;
const LONG_QUOTED = /(["'`])(?:(?!\1).){41,}?\1/g;
const NUMBER = /\d+/g;

/** Strip volatile parts so the same bug on a different id/time/token yields the same signature. */
export function normalizeMessage(message: string): string {
  return message
    .replace(LONG_QUOTED, '"…"')
    .replace(UUID, '<uuid>')
    .replace(ISO_TS, '<ts>')
    .replace(HEX, '<hex>')
    .replace(NUMBER, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function signatureFor(oracle: OracleKind, url: string, message: string): string {
  return createHash('sha1')
    .update(oracle + normalizePath(url) + normalizeMessage(message))
    .digest('hex');
}

/** Candidate factory: clips message and every string in evidence to MAX_ECHO and computes the signature. */
export function candidate(
  input: OracleInput,
  c: { oracle: OracleKind; severity: Candidate['severity']; url: string; message: string; tMs?: number; evidence?: Record<string, unknown> },
): Candidate {
  const message = clip(c.message);
  const evidence: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.evidence ?? {})) evidence[k] = typeof v === 'string' ? clip(v) : v;
  return {
    oracle: c.oracle,
    stepN: input.step.n,
    tMs: c.tMs ?? input.step.tMs,
    url: c.url,
    message,
    severity: c.severity,
    signature: signatureFor(c.oracle, c.url, message),
    evidence,
  };
}

/** Request URL as path only (no query string, which may carry tokens). */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return clip(url.split(/[?#]/)[0] ?? url, 100);
  }
}

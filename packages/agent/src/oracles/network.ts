import type { Signal } from '@gremlin/contract';
import { sameOrigin } from '../url.js';
import { candidate, pathOf, type Oracle } from './common.js';

type Net = Extract<Signal, { kind: 'network' }>;

const isApiCall = (s: Net) => s.resourceType === 'xhr' || s.resourceType === 'fetch';

/**
 * Same-origin only (third-party hosts never fire). Document responses belong to the `http` oracle.
 * - 5xx: P1 (any same-origin resource type except document)
 * - 4xx on xhr/fetch: P2, except the expected 401 when not logged in
 * - failed xhr/fetch (no status): P2, except aborts (navigation/cancel noise)
 */
export const network: Oracle = (input) =>
  input.signals.flatMap((s) => {
    if (s.kind !== 'network' || s.resourceType === 'document') return [];
    if (!sameOrigin(s.url, input.origin)) return [];
    const where = `${s.method} ${pathOf(s.url)}`;
    const evidence = {
      method: s.method,
      url: pathOf(s.url),
      status: s.status,
      resourceType: s.resourceType,
      durationMs: s.durationMs,
      ...(s.bodyKey ? { bodyKey: s.bodyKey } : {}),
      ...(s.failure ? { failure: s.failure } : {}),
    };
    const make = (severity: 'P1' | 'P2', message: string) => [
      candidate(input, { oracle: 'network', severity, url: s.url, message, tMs: s.tMs, evidence }),
    ];

    if (s.status === null) {
      if (!isApiCall(s) || /ERR_ABORTED/.test(s.failure ?? '')) return [];
      return make('P2', `${where} failed: ${s.failure ?? 'unknown'}`);
    }
    if (s.status >= 500) return make('P1', `${where} responded ${s.status}`);
    if (s.status >= 400 && isApiCall(s)) {
      if (s.status === 401 && !input.loggedIn) return [];
      return make('P2', `${where} responded ${s.status}`);
    }
    return [];
  });

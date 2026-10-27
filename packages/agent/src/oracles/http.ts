import { sameOrigin } from '../url.js';
import { candidate, pathOf, type Oracle } from './common.js';

/** A same-origin document (navigation) response with status >= 400. P1. */
export const http: Oracle = (input) =>
  input.signals.flatMap((s) => {
    if (s.kind !== 'network' || s.resourceType !== 'document' || s.status === null || s.status < 400) return [];
    if (!sameOrigin(s.url, input.origin)) return [];
    return [
      candidate(input, {
        oracle: 'http',
        severity: 'P1',
        url: s.url,
        message: `Page ${pathOf(s.url)} responded ${s.status}`,
        tMs: s.tMs,
        evidence: { method: s.method, url: pathOf(s.url), status: s.status, ...(s.bodyKey ? { bodyKey: s.bodyKey } : {}) },
      }),
    ];
  });

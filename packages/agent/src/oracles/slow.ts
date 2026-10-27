import { candidate, pathOf, type Oracle } from './common.js';

export const SLOW_REQUEST_MS = 5000;
export const SLOW_SETTLE_CAPS = 3;

/** Any request over 5 s (any host), or the settle cap hit 3+ times on this page. P3. */
export const slow: Oracle = (input) => {
  const out = [];
  for (const s of input.signals) {
    if (s.kind !== 'network' || s.durationMs <= SLOW_REQUEST_MS) continue;
    out.push(
      candidate(input, {
        oracle: 'slow',
        severity: 'P3',
        url: s.url,
        message: `${s.method} ${pathOf(s.url)} took over ${SLOW_REQUEST_MS / 1000}s`,
        tMs: s.tMs,
        evidence: { method: s.method, url: pathOf(s.url), durationMs: s.durationMs, status: s.status },
      }),
    );
  }
  if (input.settleCappedCount >= SLOW_SETTLE_CAPS) {
    out.push(
      candidate(input, {
        oracle: 'slow',
        severity: 'P3',
        url: input.observation.url,
        message: 'Page never settles: network or DOM kept changing until the settle cap, repeatedly',
        evidence: { settleCappedCount: input.settleCappedCount },
      }),
    );
  }
  return out;
};

import { candidate, type Oracle } from './common.js';

/** Uncaught exception on the page. P1. */
export const crash: Oracle = (input) =>
  input.signals.flatMap((s) =>
    s.kind === 'pageerror'
      ? [
          candidate(input, {
            oracle: 'crash',
            severity: 'P1',
            url: input.observation.url,
            message: s.message,
            tMs: s.tMs,
            evidence: { message: s.message, ...(s.stack ? { stack: s.stack } : {}) },
          }),
        ]
      : [],
  );

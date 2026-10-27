import { candidate, type Oracle } from './common.js';
import { isConsoleNoise } from './noise.js';

/**
 * Chromium logs "Failed to load resource: the server responded with a status of 500" as a console error for
 * every failed subresource. That is a duplicate of the network signal (handled by the network oracle, with
 * same-origin / expected-401 rules), so it is not reported twice.
 */
const RESOURCE_LOAD_DUPLICATE = /^Failed to load resource\b/;

/** console.error minus vendor noise. P2. */
export const consoleOracle: Oracle = (input) =>
  input.signals.flatMap((s) => {
    if (s.kind !== 'console' || s.level !== 'error') return [];
    if (isConsoleNoise(s.text, s.location) || RESOURCE_LOAD_DUPLICATE.test(s.text)) return [];
    return [
      candidate(input, {
        oracle: 'console',
        severity: 'P2',
        url: input.observation.url,
        message: s.text,
        tMs: s.tMs,
        evidence: { text: s.text, ...(s.location ? { location: s.location } : {}) },
      }),
    ];
  });

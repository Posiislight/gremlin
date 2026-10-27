import type { Candidate } from '@gremlin/contract';
import { blank } from './blank.js';
import type { Oracle, OracleInput } from './common.js';
import { consoleOracle } from './console.js';
import { crash } from './crash.js';
import { errorText } from './errorText.js';
import { http } from './http.js';
import { network } from './network.js';
import { slow } from './slow.js';

export { blank } from './blank.js';
export { candidate, clip, MAX_ECHO, normalizeMessage, signatureFor, type Oracle, type OracleInput } from './common.js';
export { consoleOracle } from './console.js';
export { crash } from './crash.js';
export { errorText } from './errorText.js';
export { http } from './http.js';
export { network } from './network.js';
export { CONSOLE_NOISE, isConsoleNoise } from './noise.js';
export { slow, SLOW_REQUEST_MS, SLOW_SETTLE_CAPS } from './slow.js';

export const ORACLES: Oracle[] = [crash, consoleOracle, network, http, errorText, blank, slow];

/** Run every oracle, drop suppressed signatures, and de-dupe by signature (first occurrence wins). */
export function runOracles(input: OracleInput, opts: { suppressed?: Set<string> } = {}): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const oracle of ORACLES) {
    for (const c of oracle(input)) {
      if (opts.suppressed?.has(c.signature) || seen.has(c.signature)) continue;
      seen.add(c.signature);
      out.push(c);
    }
  }
  return out;
}

import { candidate, clip, type Oracle } from './common.js';

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'NaN', re: /\bNaN\b/ },
  { name: 'undefined', re: /\bundefined\b/ },
  { name: 'null', re: /\bnull\b/ },
  { name: '[object Object]', re: /\[object Object\]/ },
  { name: 'something went wrong', re: /\bsomething went wrong\b/i },
  // "at fn (file:line:col)", "at file:line:col", or a Python traceback header
  { name: 'stack trace', re: /\bat [^\s()]+(?: \([^)\s]+:\d+:\d+\)|:\d+:\d+)|Traceback \(most recent call last\)/ },
];

const CONTEXT = 40;

/** Visible whole-word NaN / undefined / null / [object Object] / "something went wrong" / stack traces. P2. */
export const errorText: Oracle = (input) => {
  const { observation } = input;
  const haystack = [observation.text, ...observation.alerts].join('\n');
  const out = [];
  for (const { name, re } of PATTERNS) {
    const m = re.exec(haystack);
    if (!m) continue;
    const from = Math.max(0, m.index - CONTEXT);
    const snippet = haystack
      .slice(from, m.index + m[0].length + CONTEXT)
      .replace(/\s+/g, ' ')
      .trim();
    out.push(
      candidate(input, {
        oracle: 'error_text',
        severity: 'P2',
        url: observation.url,
        message: `Visible "${name}" on page: ${snippet}`,
        evidence: { pattern: name, matched: clip(m[0]), context: snippet },
      }),
    );
  }
  return out;
};

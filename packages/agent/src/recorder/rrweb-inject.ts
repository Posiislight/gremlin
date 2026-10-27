import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const EMIT_BINDING = '__gremlinEmit';
export const FLUSH_FN = '__gremlinFlush';
const BATCH_MS = 250;

let cached: string | undefined;

/**
 * Init script for `context.addInitScript`: the bundled rrweb UMD plus glue that
 * - runs in the top frame only, once per document (a new document = a new segment id),
 * - announces the segment immediately, then ships rrweb events every 250 ms (and on pagehide) through the
 *   `__gremlinEmit` binding. Events keep their own `timestamp` (Date.now()), so batching adds no skew.
 * pushState navigations do not run the script again: they stay in the same segment.
 */
export function rrwebInitScript(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const umd = readFileSync(join(dirname(require.resolve('rrweb')), 'rrweb.umd.min.cjs'), 'utf8');
  cached = `(() => {
  if (window.top !== window || window.__gremlinRec) return;
  Object.defineProperty(window, '__gremlinRec', { value: true });
  const rr = (() => {
    var exports, module, define;
${umd}
    const r = globalThis.rrweb;
    try { delete globalThis.rrweb; } catch (_) {}
    return r;
  })();
  const seg = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let buf = [];
  let announced = false;
  const flush = () => {
    const emit = window.${EMIT_BINDING};
    if (typeof emit !== 'function') return;
    if (announced && buf.length === 0) return;
    const events = buf;
    buf = [];
    announced = true;
    try { Promise.resolve(emit({ seg, url: location.href, events })).catch(() => {}); } catch (_) {}
  };
  Object.defineProperty(window, '${FLUSH_FN}', { value: flush });
  const start = () => {
    rr.record({
      emit: (e) => { buf.push(e); },
      maskAllInputs: false,
      maskInputOptions: { password: true },
      recordCanvas: true,
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  flush();
  setInterval(flush, ${BATCH_MS});
  addEventListener('pagehide', flush);
})();`;
  return cached;
}

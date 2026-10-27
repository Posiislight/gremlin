'use client';

import { useEffect, useRef } from 'react';
import { formatMs, stepGlyph, stepTarget, stepVerb } from '@/lib/replay/format';
import { sortSteps } from '@/lib/replay/sync';
import type { TimelineStep } from '@/lib/types';

const GLYPH = {
  ok: <span className="text-ok">✓</span>,
  fail: <span className="text-fail">✗</span>,
  warn: <span className="text-p2">!</span>,
  idle: <span className="text-ink-500">·</span>,
};

export function StepList({ steps, activeN, tMs, onSelect }: { steps: TimelineStep[]; activeN: number | null; tMs: number; onSelect: (s: TimelineStep) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = ref.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop - list.clientHeight / 2;
  }, [activeN]);

  return (
    <ol ref={ref} className="relative max-h-[320px] min-h-0 flex-1 overflow-auto lg:max-h-none">
      {sortSteps(steps).map((s) => {
        const active = s.n === activeN;
        const future = s.tMs > tMs;
        const g = stepGlyph(s);
        return (
          <li key={s.n} aria-current={active ? 'step' : undefined}>
            <button onClick={() => onSelect(s)}
              className={`relative grid w-full grid-cols-[22px_1fr_auto] gap-x-2 border-b border-ink-800 px-3 py-2.5 text-left transition-colors hover:bg-ink-800/60 ${active ? 'bg-lime/[0.07]' : ''} ${future ? 'opacity-55' : ''}`}>
              {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-lime" />}
              <span className="tnum pt-px font-mono text-[11px] text-ink-400">{s.n}</span>
              <span className="min-w-0">
                <span className={`block truncate font-mono text-[12.5px] ${active ? 'text-lime' : 'text-ink-50'}`}>
                  {stepVerb(s)}
                  {stepTarget(s) && s.action.type !== 'goto' && s.action.type !== 'expect' ? <span className="text-ink-300"> {stepTarget(s)}</span> : null}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-300">{s.intent}</span>
                {g === 'fail' && s.error && <span className="mt-1 block font-mono text-[11px] leading-snug text-p0">{s.error}</span>}
              </span>
              <span className="flex flex-col items-end gap-1 font-mono text-[11px]">
                {GLYPH[g]}
                <span className="tnum text-ink-500">{formatMs(s.tMs).slice(0, -2)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

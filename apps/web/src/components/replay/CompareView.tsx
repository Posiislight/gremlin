'use client';

// Compare skeleton: two runs side by side, one shared playhead aligned by step number (screenshots only for now).
import { useMemo, useState } from 'react';
import { alignedTime, screenshotAt, sortSteps, stepAtTime } from '@/lib/replay/sync';
import { formatMs, stepGlyph, stepVerb } from '@/lib/replay/format';
import type { ApiTimeline } from '@/lib/types';

export function CompareView({ a, b }: { a: ApiTimeline; b: ApiTimeline }) {
  const [t, setT] = useState(0);
  const tb = alignedTime(a, b, t);
  const stepsA = sortSteps(a.steps);
  const stepsB = sortSteps(b.steps);
  const cur = stepAtTime(a.steps, t);
  const rows = useMemo(() => stepsA.map((s) => ({ a: s, b: stepsB.find((x) => x.n === s.n) ?? null })), [stepsA, stepsB]);

  const pane = (label: string, tl: ApiTimeline, at: number, tone: string) => {
    const shot = screenshotAt(tl.steps, at);
    const st = stepAtTime(tl.steps, at);
    return (
      <section className="panel min-w-0 overflow-hidden">
        <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2 font-mono text-[12px]">
          <span className={tone}>{label} · {tl.runId}</span>
          <span className="tnum text-ink-300">{formatMs(at)}</span>
        </div>
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot.url} alt={`${label} screenshot at step ${shot.step.n}`} className="aspect-[16/10] w-full" />
        ) : (
          <div className="grid aspect-[16/10] place-items-center font-mono text-[12px] text-ink-400">no screenshot</div>
        )}
        <div className="border-t border-ink-700 px-3 py-2 text-[12.5px] text-ink-200">{st ? `#${st.n} ${st.intent}` : 'not started'}</div>
      </section>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        {pane('failing', a, t, 'text-p0')}
        {pane('fixed', b, tb, 'text-ok')}
      </div>
      <div className="panel p-3">
        <input type="range" min={0} max={a.durationMs} value={t} onChange={(e) => setT(Number(e.target.value))} aria-label="Shared playhead" className="w-full accent-[#b9ff3b]" />
        <div className="mt-1 flex justify-between font-mono text-[10.5px] text-ink-400">
          <span>playheads aligned by step number</span>
          <span>{cur ? `step ${cur.n}` : ''}</span>
        </div>
      </div>
      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[40px_1fr_1fr] border-b border-ink-700 px-3 py-2"><span className="label">#</span><span className="label">failing</span><span className="label">fixed</span></div>
        {rows.map((r) => (
          <button key={r.a.n} onClick={() => setT(r.a.tMs)} className={`grid w-full grid-cols-[40px_1fr_1fr] gap-2 border-b border-ink-800 px-3 py-2 text-left font-mono text-[12px] hover:bg-ink-800/60 ${cur?.n === r.a.n ? 'bg-lime/[0.07]' : ''}`}>
            <span className="text-ink-400">{r.a.n}</span>
            <span className={stepGlyph(r.a) === 'ok' ? 'text-ink-100' : 'text-p0'}>{stepVerb(r.a)}</span>
            <span className={r.b && stepGlyph(r.b) !== 'ok' ? 'text-p0' : 'text-ink-100'}>{r.b ? stepVerb(r.b) : 'missing'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

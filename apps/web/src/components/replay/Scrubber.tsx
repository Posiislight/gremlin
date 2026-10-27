'use client';

import { useRef } from 'react';
import { clamp, type Marker, type MarkerKind } from '@/lib/replay/sync';
import { formatMs } from '@/lib/replay/format';
import type { RrwebSegment } from '@/lib/types';

const LANE: Record<MarkerKind, number> = { step: 0, step_fail: 0, finding: 0, navigation: 1, console_error: 1, page_error: 1, net_fail: 2 };
const SHAPE: Record<MarkerKind, string> = {
  step: 'size-2.5 rounded-full bg-ink-200',
  step_fail: 'size-2.5 rounded-full bg-fail',
  finding: 'size-2.5 rotate-45 bg-lime',
  navigation: 'h-2.5 w-px bg-ink-400',
  console_error: 'size-0 border-x-[5px] border-b-[9px] border-x-transparent border-b-p1',
  page_error: 'size-0 border-x-[5px] border-b-[9px] border-x-transparent border-b-p0',
  net_fail: 'size-2.5 bg-p0',
};

export function Scrubber({
  durationMs, tMs, markers, segments, onSeek, onMarker,
}: {
  durationMs: number; tMs: number; markers: Marker[]; segments: RrwebSegment[]; onSeek: (ms: number) => void; onMarker: (m: Marker) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * durationMs;
  };
  const pct = clamp((tMs / Math.max(1, durationMs)) * 100, 0, 100);
  const ticks = 8;

  return (
    <div className="select-none">
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs)}
        aria-valuenow={Math.round(tMs)}
        aria-valuetext={formatMs(tMs)}
        className="relative h-[74px] cursor-col-resize touch-none rounded-md border border-ink-700 bg-ink-950"
        onPointerDown={(e) => {
          drag.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(at(e.clientX));
        }}
        onPointerMove={(e) => drag.current && onSeek(at(e.clientX))}
        onPointerUp={() => (drag.current = false)}
        onPointerCancel={() => (drag.current = false)}
      >
        {segments.map((s) => (
          <div key={s.index} className="absolute inset-y-0 border-l border-ink-700/80 bg-ink-850/60"
            style={{ left: `${(s.startMs / Math.max(1, durationMs)) * 100}%`, width: `${((s.endMs - s.startMs) / Math.max(1, durationMs)) * 100}%` }}>
            <span className="absolute bottom-0.5 left-1 font-mono text-[9px] text-ink-500">seg {s.index}</span>
          </div>
        ))}
        {[0, 1, 2].map((l) => (
          <div key={l} className="absolute inset-x-0 border-t border-ink-800" style={{ top: 10 + l * 19 }} />
        ))}
        {markers.map((m, i) => (
          <button
            key={i}
            type="button"
            title={`${formatMs(m.tMs)}  ${m.label}`}
            aria-label={m.label}
            className="absolute z-10 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center hover:scale-125"
            style={{ left: `${m.pct}%`, top: 10 + LANE[m.kind] * 19 + 9 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onMarker(m)}
          >
            <span className={SHAPE[m.kind]} />
          </button>
        ))}
        <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-lime shadow-[0_0_8px_rgba(185,255,59,.7)]" style={{ left: `${pct}%` }}>
          <div className="absolute -left-[5px] -top-px h-2 w-[11px] rounded-b bg-lime" />
        </div>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-400">
        {Array.from({ length: ticks + 1 }, (_, i) => (
          <span key={i} className={i > 0 && i < ticks && i % 2 ? 'hidden sm:inline' : ''}>{(((durationMs / ticks) * i) / 1000).toFixed(1)}s</span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-ink-400">
        <span><i className="mr-1 inline-block size-2 rounded-full bg-ink-200" />step</span>
        <span><i className="mr-1 inline-block size-2 rotate-45 bg-lime" />finding</span>
        <span><i className="mr-1 inline-block border-x-4 border-b-[7px] border-x-transparent border-b-p1" />console error</span>
        <span><i className="mr-1 inline-block size-2 bg-p0" />failed request</span>
      </div>
    </div>
  );
}

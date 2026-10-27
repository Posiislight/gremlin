'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiPath } from '@/lib/client';

export type Frame = {
  n: number;
  url: string;
  intent: string | null;
  outcome: string | null;
  actionType: string | null;
};

export type LiveAgent = {
  id: string;
  status: string;
  frames: Frame[];
};

export type FindingFlash = { title: string; priority: string; at: number } | null;

const src = (url: string) => (url.startsWith('data:') ? url : apiPath(url));

/** Loads `url` in the background and returns it only once the browser has it, so frames swap without flashing. */
function useReadyImage(url: string | null): string | null {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setReady(url);
    img.onerror = () => alive && setReady(url);
    img.src = src(url);
    return () => {
      alive = false;
    };
  }, [url]);
  return ready;
}

const ACTION_TONE: Record<string, string> = {
  click: 'bg-lime/15 text-lime',
  type: 'bg-p3/15 text-p3',
  goto: 'bg-ink-700 text-ink-100',
  expect: 'bg-ink-700 text-ink-200',
};

export function LiveView({
  agents,
  baseUrl,
  live,
  judging = false,
  flash,
}: {
  agents: LiveAgent[];
  baseUrl: string;
  live: boolean;
  /** All agents have finished; the engine is judging what they reported. */
  judging?: boolean;
  flash: FindingFlash;
}) {
  const withFrames = agents.filter((a) => a.frames.length > 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  // Follow the agent that moved most recently unless the viewer picked one.
  const latest = useMemo(() => {
    let best: LiveAgent | null = null;
    for (const a of withFrames) if (!best || a.frames[a.frames.length - 1]!.n >= best.frames[best.frames.length - 1]!.n) best = a;
    return best;
  }, [withFrames]);
  const agent = withFrames.find((a) => a.id === selected) ?? latest;

  const frames = agent?.frames ?? [];
  const frame = pinned !== null ? (frames.find((f) => f.n === pinned) ?? frames[frames.length - 1]) : frames[frames.length - 1];
  const shown = useReadyImage(frame?.url ?? null);
  const following = pinned === null;

  const [showFlash, setShowFlash] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setShowFlash(true);
    const t = window.setTimeout(() => setShowFlash(false), 5000);
    return () => window.clearTimeout(t);
  }, [flash]);

  const bad = frame?.outcome === 'error';

  return (
    <section aria-label="Live browser view">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="label">live view</h2>
          {live && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-lime">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-lime" /> {judging ? 'AGENT FINISHED · JUDGING FINDINGS' : 'WATCHING THE AGENT'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {withFrames.length > 1 &&
            withFrames.map((a, i) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setSelected(a.id);
                  setPinned(null);
                }}
                className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                  agent?.id === a.id ? 'border-lime/60 bg-lime/10 text-lime' : 'border-ink-600 text-ink-300 hover:border-ink-400'
                }`}
              >
                agent {i + 1}
              </button>
            ))}
          {!following && (
            <button
              type="button"
              onClick={() => setPinned(null)}
              className="rounded-md border border-lime/60 bg-lime/10 px-2.5 py-1 font-mono text-[11px] text-lime"
            >
              back to live
            </button>
          )}
          {agent && (
            <Link href={`/runs/${agent.id}${frame ? `?step=${frame.n}` : ''}`} className="font-mono text-[11px] text-ink-300 underline-offset-2 hover:text-ink-50 hover:underline">
              open replay
            </Link>
          )}
        </div>
      </div>

      <div className={`panel overflow-hidden transition-shadow ${bad ? 'shadow-[0_0_0_1px_var(--color-p1)]' : ''}`}>
        <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-850 px-3 py-2">
          <span className="flex gap-1.5" aria-hidden="true">
            <i className="size-2.5 rounded-full bg-ink-600" />
            <i className="size-2.5 rounded-full bg-ink-600" />
            <i className="size-2.5 rounded-full bg-ink-600" />
          </span>
          <div className="mx-2 min-w-0 flex-1 truncate rounded-md bg-ink-950 px-3 py-1 font-mono text-[11.5px] text-ink-300">{baseUrl}</div>
          {frame && <span className="tnum font-mono text-[11px] text-ink-300">step {frame.n}</span>}
        </div>

        <div className="relative aspect-[16/10] bg-ink-950">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src(shown)} alt={frame?.intent ?? 'Agent browser'} className="absolute inset-0 size-full object-contain object-top" />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <div className="hairline-grid absolute inset-0 opacity-60" />
              <p className="relative animate-pulse-dot font-mono text-[12px] text-ink-300">
                {live ? 'waiting for the agent’s first screenshot…' : 'no screenshots recorded for this scan'}
              </p>
            </div>
          )}

          {showFlash && flash && (
            <div className="absolute right-3 top-3 max-w-[70%] animate-rise rounded-md border border-p1/60 bg-ink-950/90 px-3 py-2 backdrop-blur">
              <div className="font-mono text-[10px] tracking-widest text-p1">BUG FOUND · {flash.priority}</div>
              <div className="mt-0.5 text-[13px] font-medium text-ink-50">{flash.title}</div>
            </div>
          )}

          {frame && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent px-4 pb-3 pt-10">
              <div className="flex items-center gap-2">
                {frame.actionType && (
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] ${ACTION_TONE[frame.actionType] ?? 'bg-ink-700 text-ink-200'}`}>{frame.actionType}</span>
                )}
                {bad && <span className="rounded bg-p1/20 px-1.5 py-0.5 font-mono text-[10.5px] text-p1">failed</span>}
              </div>
              <p className={`mt-1 text-[14px] leading-snug ${bad ? 'text-p1' : 'text-ink-50'}`}>{frame.intent ?? 'working…'}</p>
            </div>
          )}
        </div>

        {frames.length > 0 && (
          <ol className="flex gap-2 overflow-x-auto border-t border-ink-700 bg-ink-900 p-2" aria-label="Recent steps">
            {frames.map((f) => (
              <li key={f.n} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setPinned(f.n === frames[frames.length - 1]!.n ? null : f.n)}
                  title={f.intent ?? `step ${f.n}`}
                  className={`relative block h-14 w-[88px] overflow-hidden rounded border transition-colors ${
                    frame?.n === f.n ? 'border-lime' : f.outcome === 'error' ? 'border-p1/70' : 'border-ink-600 hover:border-ink-400'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src(f.url)} alt="" loading="lazy" className="size-full object-cover object-top" />
                  <span className="tnum absolute bottom-0 right-0 rounded-tl bg-ink-950/80 px-1 font-mono text-[9.5px] text-ink-100">{f.n}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

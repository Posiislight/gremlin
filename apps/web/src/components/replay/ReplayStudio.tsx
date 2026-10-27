'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText, sendJson, apiPath } from '@/lib/client';
import { buildReplayLink } from '@/lib/replay/deeplink';
import { formatMs } from '@/lib/replay/format';
import {
  adjacentStep, buildMarkers, clamp, offsetInSegment, screenshotAt, segmentForTime, signalsUpTo, stepAtTime, timeForStep, type Marker,
} from '@/lib/replay/sync';
import type { ApiTimeline } from '@/lib/types';
import { Btn, Kbd } from '../ui';
import { DevTools, type DevTab } from './DevTools';
import type { ElementInfo } from './DomPane';
import { Scrubber } from './Scrubber';
import { StepList } from './StepList';

const DomPane = dynamic(() => import('./DomPane'), {
  ssr: false,
  loading: () => <div className="grid aspect-[16/10] w-full place-items-center bg-ink-900 font-mono text-[12px] text-ink-300">loading replayer…</div>,
});

type Mode = 'shots' | 'video' | 'dom';
const SPEEDS = [0.5, 1, 2, 4];

export function ReplayStudio({
  timeline, initialStep, initialMode, findingId, prompt, mock,
}: {
  timeline: ApiTimeline; initialStep: number | null; initialMode: Mode | null; findingId: string | null; prompt: string; mock: boolean;
}) {
  const { steps, signals, durationMs, rrwebSegments } = timeline;
  const hasVideo = !!timeline.videoUrl;
  const hasDom = rrwebSegments.length > 0;
  const hasShots = steps.some((s) => s.screenshotUrl);

  const [mode, setMode] = useState<Mode>(() => {
    if (initialMode === 'video' && hasVideo) return 'video';
    if (initialMode === 'dom' && hasDom) return 'dom';
    if (initialMode === 'shots' && hasShots) return 'shots';
    return hasVideo ? 'video' : hasDom ? 'dom' : 'shots';
  });
  const [t, setT] = useState(() => {
    if (initialStep != null) return timeForStep(steps, initialStep) ?? 0;
    const f = timeline.findings.find((x) => x.id === findingId);
    return f ? clamp(f.tMs, 0, durationMs) : 0;
  });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [seekVersion, setSeekVersion] = useState(0);
  const [tab, setTab] = useState<DevTab>('console');
  const [inspect, setInspect] = useState(true);
  const [target, setTarget] = useState<ElementInfo | null>(null);
  const [hovered, setHovered] = useState<ElementInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const step = useMemo(() => stepAtTime(steps, t), [steps, t]);
  const shot = useMemo(() => screenshotAt(steps, t), [steps, t]);
  const markers = useMemo(() => buildMarkers({ steps, signals, findings: timeline.findings, durationMs }), [steps, signals, timeline.findings, durationMs]);
  const visibleSignals = useMemo(() => signalsUpTo(signals, durationMs), [signals, durationMs]);
  const segment = useMemo(() => segmentForTime(rrwebSegments, t), [rrwebSegments, t]);
  const targetRef = step && 'ref' in step.action ? step.action.ref : null;

  const say = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 3200);
  }, []);

  const seek = useCallback(
    (ms: number, opts: { keepPlaying?: boolean } = {}) => {
      const v = clamp(ms, 0, durationMs);
      setT(v);
      tRef.current = v;
      if (video.current) video.current.currentTime = v / 1000;
      setSeekVersion((n) => n + 1);
      if (!opts.keepPlaying && v >= durationMs) setPlaying(false);
    },
    [durationMs],
  );

  // single clock
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      let next: number;
      if (mode === 'video' && video.current && !video.current.paused) next = video.current.currentTime * 1000;
      else next = tRef.current + dt * speed;
      if (next >= durationMs) {
        setT(durationMs);
        setPlaying(false);
        return;
      }
      setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, mode, speed, durationMs]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.playbackRate = speed;
    if (playing && mode === 'video') void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, mode, speed]);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && tRef.current >= durationMs) seek(0, { keepPlaying: true });
      return !p;
    });
  }, [durationMs, seek]);

  const goStep = useCallback((dir: 1 | -1) => {
    const s = adjacentStep(steps, tRef.current, dir);
    if (s) seek(s.tMs, { keepPlaying: true });
  }, [steps, seek]);

  const setModeSafe = useCallback((m: Mode) => {
    if ((m === 'video' && !hasVideo) || (m === 'dom' && !hasDom) || (m === 'shots' && !hasShots)) return;
    setMode(m);
    setSeekVersion((n) => n + 1);
  }, [hasVideo, hasDom, hasShots]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && !(el && (el.tagName === 'BUTTON' || el.tagName === 'A'))) { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goStep(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goStep(-1); }
      else if (e.key === 'v') setModeSafe('video');
      else if (e.key === 'd') setModeSafe('dom');
      else if (e.key === 's') setModeSafe('shots');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, goStep, setModeSafe]);

  // keep the URL deep-linkable without triggering navigation
  useEffect(() => {
    if (!step) return;
    const u = new URL(window.location.href);
    u.searchParams.set('step', String(step.n));
    window.history.replaceState(null, '', u);
  }, [step?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMarker = (m: Marker) => {
    if (m.stepN != null) seek(timeForStep(steps, m.stepN) ?? m.tMs);
    else seek(m.tMs);
    if (m.kind === 'console_error' || m.kind === 'page_error') setTab('console');
    if (m.kind === 'net_fail') setTab('network');
  };

  async function share() {
    const link = buildReplayLink(window.location.origin, timeline.runId, { step: step?.n ?? null, finding: findingId });
    say((await copyText(link)) ? 'Replay link copied' : 'Could not copy link');
  }
  async function liveOrVerify(kind: 'live' | 'verify') {
    if (!findingId) return;
    let body: unknown;
    if (kind === 'verify') {
      const url = window.prompt('Preview URL to verify the fix against');
      if (!url) return;
      body = { url };
    }
    if (mock) return say(`mock: ${kind === 'live' ? 'live re-run' : 'verify'} queued`);
    const r = await sendJson<{ jobId?: string; error?: string }>('POST', `/v1/findings/${encodeURIComponent(findingId)}/${kind}`, body);
    say(r.ok ? `${kind} job queued${r.data?.jobId ? ` (${r.data.jobId})` : ''}` : `${kind} failed (${r.status || 'network'})`);
  }

  const dlBase = findingId ? apiPath(`/v1/findings/${encodeURIComponent(findingId)}`) : null;
  const segOffset = segment ? offsetInSegment(segment, t) : 0;

  return (
    <div className="space-y-3">
      <div className="studio">
        {/* steps */}
        <section className="panel flex min-h-0 flex-col overflow-hidden [grid-area:steps]">
          <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2.5">
            <h2 className="label">steps · {steps.length}</h2>
            <span className="font-mono text-[10.5px] text-ink-400">{step ? `now #${step.n}` : 'not started'}</span>
          </div>
          <StepList steps={steps} activeN={step?.n ?? null} tMs={t} onSelect={(s) => seek(s.tMs)} />
        </section>

        {/* player */}
        <section className="panel flex min-h-0 min-w-0 flex-col overflow-hidden [grid-area:player]">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-2">
            <div role="tablist" aria-label="Replay mode" className="flex rounded-md border border-ink-600 p-0.5">
              {([['shots', 'Screenshots', hasShots, 's'], ['video', 'Video', hasVideo, 'v'], ['dom', 'DOM', hasDom, 'd']] as const).map(([m, label, ok, key]) => (
                <button key={m} role="tab" aria-selected={mode === m} disabled={!ok} onClick={() => setModeSafe(m)} title={ok ? `${label} (${key})` : `${label} not available for this run`}
                  className={`rounded px-2.5 py-1 font-mono text-[11.5px] transition-colors disabled:opacity-30 ${mode === m ? 'bg-lime text-ink-950' : 'text-ink-200 hover:text-ink-50'}`}>
                  {label}
                </button>
              ))}
            </div>
            {mode === 'dom' && (
              <button onClick={() => setInspect((i) => !i)} aria-pressed={inspect} className={`rounded border px-2 py-1 font-mono text-[11px] ${inspect ? 'border-p3/60 bg-p3/10 text-p3' : 'border-ink-600 text-ink-300'}`}>
                inspect {inspect ? 'on' : 'off'}
              </button>
            )}
            <span className="tnum ml-auto font-mono text-[12px] text-ink-100">{formatMs(t)} <span className="text-ink-500">/ {formatMs(durationMs)}</span></span>
          </div>

          <div className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-[#050507] p-2 sm:p-3">
            <div className="w-full overflow-hidden rounded-md border border-ink-700 bg-ink-900 shadow-[0_8px_40px_rgba(0,0,0,.5)] lg:w-[min(100%,calc((100dvh-28rem)*1.6))]">
              {mode === 'video' && timeline.videoUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video ref={video} src={timeline.videoUrl} playsInline muted preload="metadata" className="aspect-[16/10] w-full bg-black"
                  onLoadedMetadata={(e) => { e.currentTarget.currentTime = tRef.current / 1000; }} />
              )}
              {mode === 'shots' && (shot ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shot.url} alt={`Screenshot from step ${shot.step.n}`} className="block aspect-[16/10] w-full" />
              ) : (
                <div className="grid aspect-[16/10] place-items-center font-mono text-[12px] text-ink-400">no screenshot yet</div>
              ))}
              {mode === 'dom' && segment && (
                <DomPane runId={timeline.runId} segment={segment} offsetMs={segOffset} playing={playing} speed={speed} seekVersion={seekVersion}
                  targetRef={targetRef} inspect={inspect} onTarget={setTarget} onHover={setHovered} />
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-ink-700 px-3 py-2">
            <Btn onClick={() => goStep(-1)} title="Previous step (←)" className="px-2.5">⏮</Btn>
            <Btn variant="primary" onClick={toggle} title="Play / pause (space)" className="min-w-16">{playing ? 'Pause' : 'Play'}</Btn>
            <Btn onClick={() => goStep(1)} title="Next step (→)" className="px-2.5">⏭</Btn>
            <div className="ml-1 flex rounded-md border border-ink-600 p-0.5" aria-label="Speed">
              {SPEEDS.map((sp) => (
                <button key={sp} onClick={() => setSpeed(sp)} aria-pressed={speed === sp}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${speed === sp ? 'bg-ink-600 text-ink-50' : 'text-ink-300 hover:text-ink-50'}`}>{sp}x</button>
              ))}
            </div>
            <span className="ml-auto hidden items-center gap-1.5 font-mono text-[10.5px] text-ink-400 xl:flex">
              <Kbd>space</Kbd> play <Kbd>←</Kbd><Kbd>→</Kbd> step <Kbd>v</Kbd><Kbd>d</Kbd> mode
            </span>
          </div>
        </section>

        {/* devtools */}
        <section className="panel flex min-h-[340px] min-w-0 flex-col overflow-hidden [grid-area:dev] lg:min-h-0">
          <DevTools tab={tab} onTab={setTab} signals={visibleSignals} tMs={t} step={step} onSeek={seek} target={target} hovered={hovered} dom={mode === 'dom'} />
        </section>

        {/* timeline */}
        <section className="panel p-3 [grid-area:timeline]">
          <Scrubber durationMs={durationMs} tMs={t} markers={markers} segments={rrwebSegments} onSeek={(ms) => seek(ms, { keepPlaying: true })} onMarker={onMarker} />
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={() => liveOrVerify('live')} disabled={!findingId} title={findingId ? 'Re-run the stored steps in a fresh browser' : 'Open a replay from a finding to enable'}>Replay live</Btn>
        <Btn onClick={() => liveOrVerify('verify')} disabled={!findingId}>Verify fix on URL…</Btn>
        <Btn href={dlBase ? `${dlBase}/playwright` : undefined} disabled={!findingId}>Export Playwright</Btn>
        <Btn href={dlBase ? `${dlBase}/scenario` : undefined} disabled={!findingId}>Export YAML</Btn>
        <Btn onClick={async () => say((await copyText(prompt)) ? 'Fix prompt copied' : 'Could not copy')} disabled={!prompt}>Copy fix prompt</Btn>
        <Btn variant="primary" onClick={share}>Share</Btn>
        <span role="status" className="font-mono text-[12px] text-lime">{toast}</span>
      </div>
    </div>
  );
}

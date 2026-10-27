'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useReducer } from 'react';
import { apiPath } from '@/lib/client';
import { createSseParser } from '@/lib/sse';
import { groupByPriority, formatUsd, formatTokens, relativeTime, shortId } from '@/lib/replay/format';
import { mockScanScript } from '@/lib/mock/data';
import type { ApiFindingSummary, ApiRunSummary, ScanEvent } from '@/lib/types';
import { LiveView, type Frame, type FindingFlash } from './LiveView';
import { PriorityBadge, StatusPill } from './ui';

const STAGES = ['queued', 'scanning', 'done'] as const;
const TERMINAL = new Set(['done', 'failed', 'partial']);

type RunView = { id: string; kind: string; status: string; steps: number; intent: string | null; outcome: string | null; frames: Frame[] };
const MAX_FRAMES = 24;
type State = {
  status: string;
  costUsd: number;
  runs: Record<string, RunView>;
  findings: ApiFindingSummary[];
  feed: { id: number; text: string; tone: 'ok' | 'bad' | 'new' | 'dim' }[];
  live: boolean;
  flash: FindingFlash;
};

type Action = { type: 'event'; ev: ScanEvent } | { type: 'live'; live: boolean };
let feedId = 0;

/** 1-based position of a run among the scan's agents (stable: runs are added in order). */
function agentNo(s: State, runId: string): number {
  const i = Object.keys(s.runs).indexOf(runId);
  return (i < 0 ? Object.keys(s.runs).length : i) + 1;
}

function reduce(s: State, a: Action): State {
  if (a.type === 'live') return { ...s, live: a.live };
  const ev = a.ev;
  const push = (text: string, tone: State['feed'][number]['tone']) => [{ id: feedId++, text, tone }, ...s.feed].slice(0, 40);
  switch (ev.type) {
    case 'scan':
      return { ...s, status: ev.status, costUsd: ev.costUsd, feed: push(`scan ${ev.status}`, 'dim') };
    case 'run': {
      const prev = s.runs[ev.runId];
      return { ...s, runs: { ...s.runs, [ev.runId]: { id: ev.runId, kind: ev.kind, status: ev.status, steps: prev?.steps ?? 0, intent: prev?.intent ?? null, outcome: prev?.outcome ?? null, frames: prev?.frames ?? [] } } };
    }
    case 'step': {
      const prev = s.runs[ev.runId] ?? { id: ev.runId, kind: 'scan', status: 'running', steps: 0, intent: null, outcome: null, frames: [] };
      const frames = ev.screenshotUrl
        ? [...prev.frames.filter((f) => f.n !== ev.n), { n: ev.n, url: ev.screenshotUrl, intent: ev.intent, outcome: ev.outcome, actionType: ev.actionType ?? null }].sort((a, b) => a.n - b.n).slice(-MAX_FRAMES)
        : prev.frames;
      const bad = ev.outcome === 'error';
      return {
        ...s,
        runs: { ...s.runs, [ev.runId]: { ...prev, status: prev.status === 'done' ? 'done' : 'running', steps: Math.max(prev.steps, ev.n), intent: ev.intent, outcome: ev.outcome, frames } },
        feed: push(`agent ${agentNo(s, ev.runId)} · step ${ev.n} · ${ev.intent ?? ''}`, bad ? 'bad' : 'ok'),
      };
    }
    case 'finding': {
      if (s.findings.some((f) => f.id === ev.finding.id)) return { ...s, findings: s.findings.map((f) => f.id === ev.finding.id ? ev.finding : f) };
      return { ...s, findings: [...s.findings, ev.finding], flash: { title: ev.finding.title, priority: ev.finding.priority, at: Date.now() }, feed: push(`finding ${ev.finding.priority}: ${ev.finding.title}`, 'new') };
    }
    case 'done':
      return { ...s, status: ev.status, live: false, feed: push(`scan ${ev.status}`, 'dim') };
  }
}

export function ScanLive({
  scanId, baseUrl, focus, teamSize, startedAt, initialStatus, initialCost, initialRuns, initialFindings, tokens, mock,
}: {
  scanId: string; baseUrl: string; focus: string | null; teamSize: number; startedAt: string | null; initialStatus: string; initialCost: number;
  initialRuns: ApiRunSummary[]; initialFindings: ApiFindingSummary[]; tokens: number; mock: boolean;
}) {
  const router = useRouter();
  const [s, dispatch] = useReducer(reduce, undefined, (): State => ({
    status: initialStatus,
    costUsd: initialCost,
    runs: Object.fromEntries(initialRuns.map((r) => [r.id, { id: r.id, kind: r.kind, status: r.status, steps: 0, intent: null, outcome: null, frames: [] }])),
    findings: initialFindings,
    feed: [],
    live: !TERMINAL.has(initialStatus),
    flash: null,
  }));

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return;
    if (mock) {
      const timers = mockScanScript().map(({ at, event }) => window.setTimeout(() => dispatch({ type: 'event', ev: event }), at));
      return () => timers.forEach(window.clearTimeout);
    }
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch(apiPath(`/v1/scans/${encodeURIComponent(scanId)}/events`), {
          headers: { accept: 'text/event-stream' },
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        dispatch({ type: 'live', live: true });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = createSseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const m of parser.push(value)) {
            try {
              const event = JSON.parse(m.data) as ScanEvent;
              dispatch({ type: 'event', ev: event });
              if (event.type === 'done') router.refresh();
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      } catch {
        /* aborted or dropped */
      }
      if (!ctl.signal.aborted) dispatch({ type: 'live', live: false });
    })();
    return () => ctl.abort();
  }, [initialStatus, mock, scanId, router]);

  const stageIdx = Math.max(0, STAGES.indexOf(s.status as (typeof STAGES)[number]));
  const failed = s.status === 'failed' || s.status === 'partial';
  const runs = Object.values(s.runs);
  const groups = groupByPriority(s.findings.map((f) => ({ ...f, priority: f.priority })));

  return (
    <div className="animate-rise space-y-5">
      <section className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="font-mono text-[20px] font-semibold tracking-tight text-ink-50">scan {shortId(scanId)}</h1>
              <StatusPill status={s.status} />
              {s.live && <span className="font-mono text-[10px] tracking-widest text-lime">LIVE</span>}
            </div>
            <p className="mt-1 truncate font-mono text-[12.5px] text-ink-300">{baseUrl}</p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-400">
              {teamSize} agents{focus ? ` · focus: ${focus}` : ''} · started {relativeTime(startedAt)}
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-5 text-right sm:gap-8">
            {[['cost', formatUsd(s.costUsd)], ['tokens', formatTokens(tokens)], ['findings', String(s.findings.length)]].map(([k, v]) => (
              <div key={k}>
                <dt className="label">{k}</dt>
                <dd className="tnum mt-0.5 text-[22px] font-semibold tracking-tight text-ink-50">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ol className="mt-5 grid grid-cols-3 gap-1.5" aria-label="Scan progress">
          {STAGES.map((st, i) => {
            const done = i < stageIdx || s.status === 'done';
            const cur = i === stageIdx && s.status !== 'done' && !failed;
            return (
              <li key={st} className="min-w-0">
                <div className={`h-1 rounded-full ${done ? 'bg-lime' : cur ? 'animate-pulse-dot bg-lime/70' : failed && i === stageIdx ? 'bg-fail' : 'bg-ink-700'}`} />
                <div className={`mt-1.5 truncate font-mono text-[10px] ${done || cur ? 'text-ink-100' : 'text-ink-400'}`}>{st}</div>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {(s.live || runs.some((r) => r.frames.length > 0)) && (
            <LiveView agents={runs.map((r) => ({ id: r.id, status: r.status, frames: r.frames }))} baseUrl={baseUrl} live={s.live} judging={s.live && runs.length > 0 && runs.every((r) => !['running', 'queued'].includes(r.status))} flash={s.flash} />
          )}
          <section>
            <h2 className="label mb-2.5">agents · {runs.length}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {runs.map((r, i) => {
                const live = r.status === 'running' || r.status === 'queued';
                return (
                  <Link key={r.id} href={`/runs/${r.id}`} className="panel group block overflow-hidden transition-colors hover:border-ink-500">
                    <div className="relative h-16 border-b border-ink-700 bg-ink-850">
                      <div className="hairline-grid absolute inset-0 opacity-70" />
                      <div className="absolute inset-x-3 top-3 h-1.5 rounded bg-ink-700" />
                      <div className="absolute left-3 top-7 h-1.5 w-1/2 rounded bg-ink-700" />
                      <div className={`absolute right-3 top-3 size-2 rounded-full ${live ? 'animate-pulse-dot bg-lime' : 'bg-ink-500'}`} />
                      <span className="absolute bottom-1.5 left-3 font-mono text-[10px] text-ink-300">{r.kind}</span>
                    </div>
                    <div className="space-y-1 p-3">
                      <div className="flex items-center justify-between font-mono text-[12px]">
                        <span className="text-ink-50">agent {i + 1}</span>
                        <span className="tnum text-ink-300">{r.steps ? `step ${r.steps}` : r.status}</span>
                      </div>
                      <p className={`line-clamp-2 min-h-[2.5em] text-[12.5px] leading-snug ${r.outcome === 'error' ? 'text-p1' : 'text-ink-200'}`}>
                        {r.intent ?? 'waiting for first action…'}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="label mb-2.5">findings by priority</h2>
            {groups.length === 0 ? (
              <p className="panel px-4 py-8 text-center text-[13px] text-ink-300">No findings yet. Agents are still exploring.</p>
            ) : (
              <div className="space-y-4">
                {groups.map((g) => (
                  <div key={g.priority} className="panel overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2">
                      <PriorityBadge p={g.priority} />
                      <span className="font-mono text-[11px] text-ink-300">{g.items.length} {g.items.length === 1 ? 'finding' : 'findings'}</span>
                    </div>
                    <ul className="divide-y divide-ink-800">
                      {g.items.map((f) => (
                        <li key={f.id}>
                          <Link href={`/findings/${f.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-800/60">
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium text-ink-50">{f.title}</div>
                              <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-300">
                                {f.oracle ?? 'agent'} · seen by {f.occurrenceCount} {f.occurrenceCount === 1 ? 'agent' : 'agents'}
                              </div>
                            </div>
                            <StatusPill status={f.status} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="panel h-fit overflow-hidden lg:sticky lg:top-16">
          <div className="border-b border-ink-700 px-4 py-2.5"><h2 className="label">activity</h2></div>
          <ul className="max-h-[480px] divide-y divide-ink-800 overflow-auto font-mono text-[11.5px]" aria-live="polite">
            {s.feed.length === 0 && <li className="px-4 py-6 text-center text-ink-400">{s.live ? 'listening…' : 'no live events'}</li>}
            {s.feed.map((f) => (
              <li key={f.id} className={`animate-rise px-4 py-2 leading-snug ${f.tone === 'bad' ? 'text-p1' : f.tone === 'new' ? 'text-lime' : f.tone === 'dim' ? 'text-ink-300' : 'text-ink-200'}`}>
                {f.text}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

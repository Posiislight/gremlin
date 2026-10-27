'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { consoleEntries, filterConsole, networkEntries, waterfall, type ConsoleLevel } from '@/lib/replay/devtools';
import { formatDuration, formatMs, httpTone, shortUrl, stepTarget, stepVerb } from '@/lib/replay/format';
import type { Signal, TimelineStep } from '@/lib/types';
import type { ElementInfo } from './DomPane';

export type DevTab = 'console' | 'network' | 'element' | 'agent';
const TABS: DevTab[] = ['console', 'network', 'element', 'agent'];

const TONE: Record<string, string> = { ok: 'text-ok', redirect: 'text-p3', client: 'text-p1', server: 'text-p0', failed: 'text-p0' };

/** Keep the last "already happened" row visible without scrolling the page. */
function useFollow(listRef: React.RefObject<HTMLElement | null>, activeIdx: number) {
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop - list.clientHeight + row.offsetHeight + 8;
  }, [listRef, activeIdx]);
}

export function DevTools({
  tab, onTab, signals, tMs, step, onSeek, target, hovered, dom,
}: {
  tab: DevTab; onTab: (t: DevTab) => void; signals: Signal[]; tMs: number; step: TimelineStep | null; onSeek: (ms: number) => void;
  target: ElementInfo | null; hovered: ElementInfo | null; dom: boolean;
}) {
  const [levels, setLevels] = useState<Set<ConsoleLevel>>(new Set(['error', 'warning']));
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const cons = useMemo(() => consoleEntries(signals), [signals]);
  const shown = useMemo(() => filterConsole(cons, levels, q), [cons, levels, q]);
  const net = useMemo(() => networkEntries(signals), [signals]);
  const wf = useMemo(() => waterfall(net), [net]);
  const consoleRef = useRef<HTMLUListElement>(null);
  const netRef = useRef<HTMLDivElement>(null);
  useFollow(consoleRef, shown.filter((e) => e.tMs <= tMs).length - 1);
  useFollow(netRef, net.filter((e) => e.tMs <= tMs).length - 1);

  const toggle = (l: ConsoleLevel) =>
    setLevels((s) => {
      const n = new Set(s);
      if (n.has(l)) n.delete(l);
      else n.add(l);
      return n;
    });

  const counts: Record<DevTab, number | null> = {
    console: cons.filter((e) => e.tMs <= tMs).length,
    network: net.filter((e) => e.tMs <= tMs).length,
    element: null,
    agent: null,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" className="flex border-b border-ink-700">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => onTab(t)}
            className={`relative flex-1 px-2 py-2.5 font-mono text-[11.5px] transition-colors ${tab === t ? 'text-lime' : 'text-ink-300 hover:text-ink-50'}`}>
            {t}
            {counts[t] ? <span className="ml-1 text-ink-400">{counts[t]}</span> : null}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-px bg-lime" />}
          </button>
        ))}
      </div>

      {tab === 'console' && (
        <>
          <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
            {(['error', 'warning'] as const).map((l) => (
              <button key={l} onClick={() => toggle(l)} aria-pressed={levels.has(l)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] ${levels.has(l) ? (l === 'error' ? 'border-p0/50 bg-p0/10 text-p0' : 'border-p2/50 bg-p2/10 text-p2') : 'border-ink-600 text-ink-400'}`}>
                {l}
              </button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter" aria-label="Filter console"
              className="ml-auto h-6 w-28 rounded border border-ink-600 bg-ink-950 px-2 font-mono text-[11px] text-ink-50 placeholder:text-ink-500 focus:border-lime/60 focus:outline-none" />
          </div>
          <ul ref={consoleRef} className="relative min-h-0 flex-1 overflow-auto font-mono text-[11.5px]">
            {shown.length === 0 && <li className="px-4 py-8 text-center text-ink-400">no console output</li>}
            {shown.map((e, i) => {
              const future = e.tMs > tMs;
              return (
                <li key={i} data-row={i} className={`border-b border-ink-800 ${future ? 'opacity-35' : ''}`}>
                  <button onClick={() => { onSeek(e.tMs); setOpen(open === i ? null : i); }} className={`grid w-full grid-cols-[14px_56px_1fr] gap-2 px-3 py-1.5 text-left hover:bg-ink-800/60 ${e.level === 'error' ? 'bg-p0/[0.04]' : ''}`}>
                    <span className={e.level === 'error' ? 'text-p0' : 'text-p2'}>{e.level === 'error' ? '✕' : '!'}</span>
                    <span className="tnum text-ink-400">{formatMs(e.tMs)}</span>
                    <span className="min-w-0">
                      <span className={`break-words ${e.level === 'error' ? 'text-p0' : 'text-p2'}`}>{e.pageError ? 'Uncaught ' : ''}{e.text}</span>
                      {e.location && <span className="block text-ink-400">{e.location}</span>}
                      {open === i && e.stack && <pre className="mt-1 whitespace-pre-wrap text-ink-300">{e.stack}</pre>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {tab === 'network' && (
        <div ref={netRef} className="relative min-h-0 flex-1 overflow-auto font-mono text-[11.5px]">
          {net.length === 0 && <p className="px-4 py-8 text-center text-ink-400">no requests recorded</p>}
          {net.map((n, i) => {
            const tone = httpTone(n.status, n.failure);
            return (
              <div key={i} data-row={i} className={`border-b border-ink-800 ${n.tMs > tMs ? 'opacity-35' : ''}`}>
                <button onClick={() => { onSeek(n.tMs); setOpen(open === 1000 + i ? null : 1000 + i); }}
                  className={`grid w-full grid-cols-[38px_34px_1fr_52px] items-center gap-2 px-3 py-1.5 text-left hover:bg-ink-800/60 ${n.failed ? 'bg-p0/[0.05]' : ''}`}>
                  <span className="text-ink-300">{n.method}</span>
                  <span className={`tnum ${TONE[tone]}`}>{n.status ?? 'ERR'}</span>
                  <span className="min-w-0 truncate text-ink-100" title={n.url}>{shortUrl(n.url, 48)}</span>
                  <span className="tnum text-right text-ink-300">{formatDuration(n.durationMs)}</span>
                  <span className="col-span-4 -mt-0.5 block h-1 rounded-full bg-ink-800">
                    <span className={`block h-1 rounded-full ${n.failed ? 'bg-p0' : 'bg-p3/70'}`} style={{ marginLeft: `${wf[i]!.left}%`, width: `${Math.min(wf[i]!.width, 100 - wf[i]!.left)}%` }} />
                  </span>
                </button>
                {open === 1000 + i && (
                  <dl className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-1 bg-ink-950 px-3 py-2 text-ink-300">
                    <dt>url</dt><dd className="break-all text-ink-100">{n.url}</dd>
                    <dt>type</dt><dd>{n.resourceType}</dd>
                    <dt>started</dt><dd>{formatMs(n.tMs)}</dd>
                    {n.failure && (<><dt>failure</dt><dd className="text-p0">{n.failure}</dd></>)}
                    {n.bodyKey && (<><dt>body</dt><dd className="break-all text-ink-100">{n.bodyKey}</dd></>)}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'element' && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 font-mono text-[11.5px]">
          {hovered && <ElementCard title="hovered" info={hovered} accent="text-p3" />}
          {target ? (
            <ElementCard title={`target at step ${step?.n ?? ''}`} info={target} accent="text-lime" />
          ) : step ? (
            <div>
              <div className="label mb-1.5 text-lime">locator at step {step.n}</div>
              {step.locator ? (
                <dl className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-1">
                  {Object.entries(step.locator).map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-ink-400">{k}</dt><dd className="break-all text-ink-100">{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>
                  ))}
                </dl>
              ) : (
                <p className="text-ink-400">This step has no element target.</p>
              )}
              {!dom && <p className="mt-3 text-ink-400">Switch to DOM mode (<kbd className="rounded border border-ink-600 px-1">d</kbd>) to inspect live nodes, attributes and text.</p>}
            </div>
          ) : (
            <p className="text-ink-400">Seek to a step to see its target.</p>
          )}
        </div>
      )}

      {tab === 'agent' && (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-[13px]">
          {step ? (
            <>
              <div>
                <div className="label mb-1">step {step.n} · {formatMs(step.tMs)}</div>
                <p className="font-mono text-[12px] text-lime">{stepVerb(step)}{stepTarget(step) ? ` → ${stepTarget(step)}` : ''}</p>
              </div>
              <Field label="intent" value={step.intent} />
              {step.expectation && <Field label="expectation" value={step.expectation} />}
              {step.error && <Field label="error" value={step.error} tone="text-p0" />}
              <Field label="reasoning" value={step.reasoningSummary ?? 'No reasoning summary recorded.'} />
              <div>
                <div className="label mb-1">action</div>
                <pre className="overflow-auto rounded-md border border-ink-700 bg-ink-950 p-2.5 font-mono text-[11px] leading-relaxed text-ink-200">{JSON.stringify(step.action, null, 2)}</pre>
              </div>
              <p className="font-mono text-[11px] text-ink-400">outcome <span className={step.outcome === 'ok' ? 'text-ok' : 'text-p1'}>{step.outcome}</span> · {step.signals.length} signals</p>
            </>
          ) : (
            <p className="text-ink-400">The agent has not acted yet at this time.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, tone = 'text-ink-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <p className={`leading-relaxed ${tone}`}>{value}</p>
    </div>
  );
}

function ElementCard({ title, info, accent }: { title: string; info: ElementInfo; accent: string }) {
  return (
    <div>
      <div className={`label mb-1.5 ${accent}`}>{title}</div>
      <p className="mb-1.5 break-all text-ink-100">&lt;{info.tag}&gt; <span className="text-ink-400">{info.path}</span></p>
      {info.text && <p className="mb-2 text-ink-200">“{info.text}”</p>}
      <dl className="mb-2 grid grid-cols-[96px_1fr] gap-x-2 gap-y-0.5">
        {Object.entries(info.attrs).map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-p3">{k}</dt><dd className="break-all text-ink-200">{v}</dd></div>
        ))}
      </dl>
      <pre className="overflow-auto whitespace-pre-wrap rounded-md border border-ink-700 bg-ink-950 p-2 text-[10.5px] text-ink-300">{info.html}</pre>
    </div>
  );
}

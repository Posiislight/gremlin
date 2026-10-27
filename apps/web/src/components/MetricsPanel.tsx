import type { ProjectMetrics } from '@/lib/types';
import { formatDuration, formatPercent, formatTokens, formatUsd } from '@/lib/replay/format';
import { metricDelta, sparkPath, type MetricKey } from '@/lib/replay/metrics';

type Row = { key: MetricKey; label: string; fmt: (n: number) => string; hint: string };
const ROWS: Row[] = [
  { key: 'tokens', label: 'tokens', fmt: formatTokens, hint: 'LLM tokens per scan' },
  { key: 'costUsd', label: 'cost', fmt: formatUsd, hint: 'spend per scan' },
  { key: 'wallMs', label: 'wall time', fmt: formatDuration, hint: 'start to done' },
  { key: 'stepsPerFinding', label: 'steps / finding', fmt: (n) => n.toFixed(0), hint: 'exploration efficiency' },
  { key: 'falsePositiveRate', label: 'false positives', fmt: (n) => formatPercent(n), hint: 'dismissed or unconfirmed' },
  { key: 'confirmed', label: 'confirmed bugs', fmt: (n) => String(n), hint: 'reproduced on replay' },
  { key: 'regressionCatches', label: 'regression catches', fmt: (n) => String(n), hint: 'known scenarios that failed again' },
];

function Spark({ values, good }: { values: number[]; good: boolean | null }) {
  const w = 96;
  const h = 26;
  const d = sparkPath(values, w, h);
  const color = good === null ? '#5b5b6b' : good ? '#46d68c' : '#ff4d5e';
  const last = values.length ? values[values.length - 1]! : 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const cy = h - 2 - ((last - min) / span) * (h - 4);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={values.length === 1 ? w / 2 : w - 2} cy={cy} r="2.4" fill={color} />
    </svg>
  );
}

export function MetricsPanel({ metrics, source }: { metrics: ProjectMetrics | null; source: 'engine' | 'mock' }) {
  if (!metrics || metrics.points.length === 0) {
    return (
      <section className="panel p-4" aria-label="Improvement metrics">
        <h2 className="label mb-2">improvement</h2>
        <p className="text-[13px] text-ink-300">Metrics appear after two scans on the same project.</p>
      </section>
    );
  }
  const pts = metrics.points;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const tokenDrop = first.tokens ? 1 - last.tokens / first.tokens : 0;
  return (
    <section className="panel overflow-hidden" aria-label="Improvement metrics">
      <div className="relative border-b border-ink-700 p-4">
        <div className="hairline-grid pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <h2 className="label">it learns</h2>
            <p className="mt-1.5 text-[22px] font-semibold leading-tight tracking-tight text-ink-50">
              <span className="text-lime">{formatPercent(tokenDrop)}</span> fewer tokens
              <br />
              than {pts.length - 1} scans ago
            </p>
          </div>
          {source === 'mock' && <span className="font-mono text-[10px] tracking-widest text-p2">SAMPLE</span>}
        </div>
        <div className="relative mt-3 flex gap-5 font-mono text-[11px] text-ink-300">
          <span>
            fix rate <b className="text-ink-50">{formatPercent(metrics.fixRate)}</b>
          </span>
          <span>
            median fix <b className="text-ink-50">{formatDuration(metrics.medianTimeToFixMs)}</b>
          </span>
        </div>
      </div>
      <ul className="divide-y divide-ink-800">
        {ROWS.map((r) => {
          const d = metricDelta(pts, r.key);
          const vals = pts.map((p) => p[r.key]);
          const tone = d.improved === null ? 'text-ink-300' : d.improved ? 'text-ok' : 'text-fail';
          const arrow = d.delta === null || d.delta === 0 ? '' : d.delta < 0 ? '↓' : '↑';
          return (
            <li key={r.key} title={r.hint} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-2.5">
              <div>
                <div className="font-mono text-[11px] text-ink-300">{r.label}</div>
                <div className="tnum text-[17px] font-semibold tracking-tight text-ink-50">{r.fmt(d.current)}</div>
              </div>
              <Spark values={vals} good={d.improved} />
              <div className={`tnum w-14 text-right font-mono text-[11.5px] ${tone}`}>
                {d.pct === null ? (d.delta === null ? '' : 'new') : `${arrow}${Math.abs(d.pct * 100).toFixed(0)}%`}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-ink-700 px-4 py-2 font-mono text-[10.5px] text-ink-400">
        {last.label} vs {pts[pts.length - 2]?.label ?? 'n/a'} on the same project
      </div>
    </section>
  );
}

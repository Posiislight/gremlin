import Link from 'next/link';
import { FORCE_MOCK, getMetrics, listProjects, listScans } from '@/lib/api';
import { formatUsd, relativeTime } from '@/lib/replay/format';
import { MetricsPanel } from '@/components/MetricsPanel';
import { NewScan } from '@/components/NewScan';
import { SourceBadge, StatusPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  const projects = await listProjects();
  const active = projects.data.find((p) => p.id === project) ?? projects.data[0];
  const [scans, metrics] = active ? await Promise.all([listScans(active.id), getMetrics(active.id)]) : [null, null];
  const source = projects.source;
  const mock = FORCE_MOCK || source === 'mock';

  return (
    <div className="animate-rise space-y-6">
      <section className="relative overflow-hidden rounded-xl border border-ink-700 bg-ink-900 px-5 py-7 sm:px-8 sm:py-9">
        <div className="hairline-grid pointer-events-none absolute inset-0" />
        <div className="relative max-w-3xl">
          <div className="mb-3 flex items-center gap-3">
            <span className="label">gremlin / projects</span>
            <SourceBadge source={source} />
          </div>
          <h1 className="text-[30px] font-semibold leading-[1.08] tracking-[-0.03em] text-ink-50 sm:text-[44px]">
            Every bug ships with a replay
            <span className="text-lime"> you can inspect.</span>
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-200">
            A swarm of browser agents explores your app, confirms what breaks, and hands your coding agent the video, the DOM, the console and a fix prompt.
          </p>
        </div>
      </section>

      <NewScan mock={mock} defaultUrl={mock ? 'https://shop.example.test' : ''} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {projects.data.map((p) => (
              <Link key={p.id} href={`/?project=${p.id}`} scroll={false}
                className={`rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors ${p.id === active?.id ? 'border-lime/50 bg-lime/10 text-lime' : 'border-ink-600 text-ink-200 hover:border-ink-400'}`}>
                {p.name}
              </Link>
            ))}
          </div>

          <section className="panel overflow-hidden" aria-label="Scans">
            <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
              <h2 className="label">scans</h2>
              <span className="font-mono text-[11px] text-ink-400">{scans?.data.length ?? 0} total</span>
            </div>
            {scans && scans.data.length > 0 ? (
              <ul className="divide-y divide-ink-800">
                {scans.data.map((s) => (
                  <li key={s.id}>
                    <Link href={`/scans/${s.id}`} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-ink-800/60 sm:grid-cols-[110px_1fr_auto_auto_90px]">
                      <span className="font-mono text-[12.5px] text-ink-50">{s.id.replace('scn_', '#')}</span>
                      <span className="order-last col-span-2 min-w-0 truncate font-mono text-[12px] text-ink-300 sm:order-none sm:col-span-1">{s.baseUrl}</span>
                      <span className="flex items-center gap-2 font-mono text-[11.5px]">
                        {s.p0 > 0 && <span className="text-p0">{s.p0} P0</span>}
                        {s.p1 > 0 && <span className="text-p1">{s.p1} P1</span>}
                        <span className="text-ink-400">{s.findingCount} findings</span>
                      </span>
                      <span className="tnum hidden font-mono text-[12px] text-ink-300 sm:block">{formatUsd(s.costUsd)}</span>
                      <span className="flex flex-col items-end gap-0.5 sm:items-start">
                        <StatusPill status={s.status} />
                        <span className="font-mono text-[10.5px] text-ink-400">{relativeTime(s.startedAt)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-[13px] text-ink-300">No scans yet. Paste a URL above and run one.</p>
            )}
          </section>
        </div>

        <MetricsPanel metrics={metrics?.data ?? null} source={metrics?.source ?? source} />
      </div>
    </div>
  );
}

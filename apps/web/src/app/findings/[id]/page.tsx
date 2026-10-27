import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFinding, getFixPrompt } from '@/lib/api';
import { buildReplayLink } from '@/lib/replay/deeplink';
import { formatMs, relativeTime, shortId, shortUrl } from '@/lib/replay/format';
import { FindingActions } from '@/components/FindingActions';
import { PriorityBadge, SourceBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

type Verdict = { isBug: boolean; reasoning: string } | { reason: string };

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await getFinding(id);
  if (!res) notFound();
  const f = res.data;
  const prompt = await getFixPrompt(id);
  const verdict = f.verdict as Verdict | null;
  const first = f.occurrences[0];

  return (
    <div className="animate-rise space-y-5">
      <div className="flex items-center gap-3 font-mono text-[12px] text-ink-300">
        {f.scanId ? <Link href={`/scans/${f.scanId}`} className="hover:text-ink-50">scan {shortId(f.scanId)}</Link> : <span>scan</span>}
        <span className="text-ink-500">/</span>
        <span className="text-ink-100">{f.id}</span>
        <SourceBadge source={res.source} />
      </div>

      <header className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <PriorityBadge p={f.priority} />
          <span className="font-mono text-[11.5px] text-ink-300">{f.oracle ?? 'agent report'} oracle</span>
          <span className="font-mono text-[11.5px] text-ink-400">· seen by {f.occurrenceCount} {f.occurrenceCount === 1 ? 'agent' : 'agents'} · {relativeTime(f.createdAt)}</span>
        </div>
        <h1 className="mt-3 max-w-4xl text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink-50 sm:text-[32px]">{f.title}</h1>
        {f.url && <p className="mt-2 font-mono text-[12px] text-ink-300">{f.url}</p>}
        <div className="mt-5 border-t border-ink-700 pt-4">
          <FindingActions id={f.id} status={f.status} prompt={prompt} mock={res.source === 'mock'} />
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <section className="grid gap-px overflow-hidden rounded-[10px] border border-ink-700 bg-ink-700 sm:grid-cols-2">
            <div className="bg-ink-900 p-4">
              <div className="label mb-1.5 text-ok">expected</div>
              <p className="text-[14px] leading-relaxed text-ink-100">{f.expected}</p>
            </div>
            <div className="bg-ink-900 p-4">
              <div className="label mb-1.5 text-p0">actual</div>
              <p className="text-[14px] leading-relaxed text-ink-100">{f.actual}</p>
            </div>
          </section>

          <section>
            <h2 className="label mb-2.5">evidence</h2>
            {f.screenshotUrls.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {f.screenshotUrls.map((u, i) => (
                  <Link key={i} href={first ? buildReplayLink('', first.runId, { step: Math.max(1, first.stepN - (f.screenshotUrls.length - 1 - i)), finding: f.id }) : '#'}
                    className="group relative block overflow-hidden rounded-[10px] border border-ink-700 bg-ink-900 transition-colors hover:border-lime/50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt={`Screenshot ${i + 1}`} className="aspect-[1.6] w-full" />
                    <span className="absolute bottom-2 left-2 rounded bg-ink-950/85 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-100 opacity-0 transition-opacity group-hover:opacity-100">open in replay</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="panel px-4 py-6 text-center text-[13px] text-ink-300">No screenshots attached.</p>
            )}
          </section>

          <section className="panel">
            <div className="border-b border-ink-700 px-4 py-2.5"><h2 className="label">judge verdict</h2></div>
            <div className="p-4 text-[13.5px] leading-relaxed text-ink-200">
              {verdict && 'reasoning' in verdict ? (
                <>
                  <p className="mb-2 font-mono text-[12px] text-ok">isBug = {String(verdict.isBug)}</p>
                  <p>{verdict.reasoning}</p>
                </>
              ) : verdict && 'reason' in verdict ? (
                <p className="text-ink-300">{verdict.reason}</p>
              ) : (
                <p className="text-ink-400">Not judged yet.</p>
              )}
              {f.confirm != null && (
                <p className="mt-3 border-t border-ink-800 pt-3 font-mono text-[12px] text-ink-300">
                  replay confirmation: <span className="text-ink-50">{JSON.stringify(f.confirm)}</span>
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
              <h2 className="label">fix prompt</h2>
              {f.promptVariant && <span className="font-mono text-[10.5px] text-ink-400">variant {f.promptVariant}</span>}
            </div>
            <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed text-ink-200">{prompt || 'Prompt unavailable.'}</pre>
          </section>
        </div>

        <aside className="space-y-5">
          <section className="panel overflow-hidden">
            <div className="border-b border-ink-700 px-4 py-2.5"><h2 className="label">occurrences · {f.occurrences.length}</h2></div>
            <ul className="divide-y divide-ink-800">
              {f.occurrences.map((o, i) => (
                <li key={i}>
                  <Link href={buildReplayLink('', o.runId, { step: o.stepN, finding: f.id })} className="group block px-4 py-3 transition-colors hover:bg-ink-800/60">
                    <div className="flex items-center justify-between font-mono text-[12px]">
                      <span className="text-ink-50">agent {shortId(o.runId)} · step {o.stepN}</span>
                      <span className="tnum text-ink-300">{formatMs(o.tMs)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-300">{o.intent ?? shortUrl(f.url ?? '')}</p>
                    <span className="mt-1.5 inline-block font-mono text-[11px] text-lime opacity-70 group-hover:opacity-100">open replay →</span>
                  </Link>
                </li>
              ))}
              {f.occurrences.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-ink-400">No recorded occurrences.</li>}
            </ul>
          </section>
          <section className="panel space-y-1.5 p-4 font-mono text-[11.5px] text-ink-300">
            <div className="label mb-2">signature</div>
            <p className="break-all text-ink-100">{f.signature}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

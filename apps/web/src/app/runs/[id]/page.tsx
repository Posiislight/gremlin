import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFixPrompt, getTimeline } from '@/lib/api';
import { parseReplayLink } from '@/lib/replay/deeplink';
import { formatDuration } from '@/lib/replay/format';
import { ReplayStudio } from '@/components/replay/ReplayStudio';
import { SourceBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Replay' };

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const link = parseReplayLink(sp);
  const res = await getTimeline(id);
  if (!res) notFound();
  const prompt = link.finding ? await getFixPrompt(link.finding) : '';
  const m = typeof sp.mode === 'string' ? sp.mode : null;
  const mode = m === 'dom' || m === 'video' || m === 'shots' ? m : null;
  const t = res.data;
  return (
    <div className="animate-rise space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-ink-300">
        <Link href="/" className="hover:text-ink-50">scans</Link>
        <span className="text-ink-500">/</span>
        <span className="text-ink-100">{id}</span>
        {link.finding && (<><span className="text-ink-500">/</span><Link href={`/findings/${link.finding}`} className="text-lime hover:underline">{link.finding}</Link></>)}
        <span className="text-ink-500">{t.steps.length} steps · {formatDuration(t.durationMs)}</span>
        <SourceBadge source={res.source} />
        <Link href={`/compare?a=${id}&b=run_fixed`} className="ml-auto hover:text-ink-50">compare →</Link>
      </div>
      <ReplayStudio timeline={t} initialStep={link.step} initialMode={mode} findingId={link.finding} prompt={prompt} mock={res.source === 'mock'} />
    </div>
  );
}

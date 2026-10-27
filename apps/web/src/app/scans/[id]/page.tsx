import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getScan } from '@/lib/api';
import { ScanLive } from '@/components/ScanLive';
import { SourceBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await getScan(id);
  if (!res) notFound();
  const s = res.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 font-mono text-[12px] text-ink-300">
        <Link href="/" className="hover:text-ink-50">scans</Link>
        <span className="text-ink-500">/</span>
        <span className="text-ink-100">{id}</span>
        <SourceBadge source={res.source} />
      </div>
      <ScanLive
        scanId={s.id} baseUrl={s.baseUrl} focus={s.focus} teamSize={s.teamSize} startedAt={s.startedAt} initialStatus={s.status}
        initialCost={s.costUsd} initialRuns={s.runs} initialFindings={s.findings} tokens={s.cost.tokens} mock={res.source === 'mock'}
      />
    </div>
  );
}

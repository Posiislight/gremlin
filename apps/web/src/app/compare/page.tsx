import { notFound } from 'next/navigation';
import { getTimeline } from '@/lib/api';
import { CompareView } from '@/components/replay/CompareView';
import { SourceBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Compare runs' };

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a = 'run_demo', b = 'run_fixed' } = await searchParams;
  const [ra, rb] = await Promise.all([getTimeline(a), getTimeline(b)]);
  if (!ra || !rb) notFound();
  return (
    <div className="animate-rise space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink-50">Compare runs</h1>
        <SourceBadge source={ra.source === 'mock' || rb.source === 'mock' ? 'mock' : 'engine'} />
      </div>
      <CompareView a={ra.data} b={rb.data} />
    </div>
  );
}

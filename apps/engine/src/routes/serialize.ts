import { count, inArray } from 'drizzle-orm';
import type { ApiFindingSummary, ApiRunSummary } from '@gremlin/contract';
import { findingOccurrences, type agentRuns, type Db, type findings } from '@gremlin/db';

type FindingRow = typeof findings.$inferSelect;
type RunRow = typeof agentRuns.$inferSelect;

export function findingSummary(f: FindingRow, occurrenceCount: number): ApiFindingSummary {
  return {
    id: f.id,
    projectId: f.projectId,
    scanId: f.scanId,
    signature: f.signature,
    priority: f.priority as ApiFindingSummary['priority'],
    title: f.title,
    expected: f.expected,
    actual: f.actual,
    status: f.status,
    url: f.url,
    oracle: f.oracle,
    unjudged: f.unjudged,
    fixStatus: f.fixStatus,
    occurrenceCount,
    createdAt: f.createdAt.toISOString(),
  };
}

export async function summarizeFindings(db: Db, rows: FindingRow[]): Promise<ApiFindingSummary[]> {
  if (!rows.length) return [];
  const counts = await db
    .select({ id: findingOccurrences.findingId, n: count() })
    .from(findingOccurrences)
    .where(inArray(findingOccurrences.findingId, rows.map((r) => r.id)))
    .groupBy(findingOccurrences.findingId);
  const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
  return rows.map((r) => findingSummary(r, byId.get(r.id) ?? 0));
}

export function runSummary(r: RunRow): ApiRunSummary {
  return {
    id: r.id,
    scanId: r.scanId,
    charterId: r.charterId,
    kind: r.kind,
    status: r.status,
    t0: r.t0 ? r.t0.toISOString() : null,
    tokens: r.tokens,
    costUsd: r.costUsd,
    error: r.error,
    hasVideo: !!r.videoKey,
    hasRrweb: !!r.rrwebKey,
    hasTimeline: !!r.timelineKey,
  };
}


import { and, eq } from 'drizzle-orm';
import { agentRuns, environments, findingOccurrences, findings, scans, type Db } from '@gremlin/db';

/** Scan row (+ base URL) when it belongs to the project. */
export async function ownedScan(db: Db, projectId: string, scanId: string) {
  const [row] = await db
    .select({ scan: scans, baseUrl: environments.baseUrl })
    .from(scans)
    .innerJoin(environments, eq(scans.environmentId, environments.id))
    .where(and(eq(scans.id, scanId), eq(environments.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** Run row when its scan belongs to the project, or (scan-less verify/live runs) one of the project's findings cites it. */
export async function ownedRun(db: Db, projectId: string, runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) return null;
  if (run.scanId) return (await ownedScan(db, projectId, run.scanId)) ? run : null;
  const [occ] = await db
    .select({ id: findingOccurrences.findingId })
    .from(findingOccurrences)
    .innerJoin(findings, eq(findings.id, findingOccurrences.findingId))
    .where(and(eq(findingOccurrences.agentRunId, runId), eq(findings.projectId, projectId)))
    .limit(1);
  return occ ? run : null;
}

export async function ownedFinding(db: Db, projectId: string, findingId: string) {
  const [f] = await db
    .select()
    .from(findings)
    .where(and(eq(findings.id, findingId), eq(findings.projectId, projectId)))
    .limit(1);
  return f ?? null;
}


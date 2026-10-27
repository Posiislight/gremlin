import { sql } from 'drizzle-orm';
import { agentRuns, findingOccurrences, findings } from '@gremlin/db';

/** A finding belongs to its first scan and every later scan that reproduced it. EXISTS avoids duplicate rows. */
export function inScan(scanId: string) {
  return sql`(${findings.scanId} = ${scanId} or exists (
    select 1 from ${findingOccurrences}
    inner join ${agentRuns} on ${agentRuns.id} = ${findingOccurrences.agentRunId}
    where ${findingOccurrences.findingId} = ${findings.id} and ${agentRuns.scanId} = ${scanId}
  ))`;
}

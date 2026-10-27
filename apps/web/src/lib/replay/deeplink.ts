export type ReplayLink = { step: number | null; finding: string | null };

export function parseReplayLink(params: Record<string, string | string[] | undefined> | URLSearchParams): ReplayLink {
  const get = (k: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(k);
    const v = params[k];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };
  const raw = get('step');
  const n = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  const f = get('finding');
  return { step: n, finding: f && /^[\w-]{1,64}$/.test(f) ? f : null };
}

export function buildReplayLink(origin: string, runId: string, link: Partial<ReplayLink>): string {
  const q = new URLSearchParams();
  if (link.step != null) q.set('step', String(link.step));
  if (link.finding) q.set('finding', link.finding);
  const qs = q.toString();
  return `${origin.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}${qs ? `?${qs}` : ''}`;
}

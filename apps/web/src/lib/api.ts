// Server-side engine client. Sample data requires explicit mock mode (or an unconfigured offline preview).
// The API key (GREMLIN_API_KEY) is only ever read here and in the /api/gremlin proxy, never shipped to the browser.
import type {
  ApiFindingDetail,
  ApiProject,
  ApiScanDetail,
  ApiTimeline,
  ProjectMetrics,
  ScanListItem,
  Sourced,
} from './types';
import {
  MOCK_PROJECT,
  mockFindingDetail,
  mockFixPrompt,
  mockMetrics,
  mockProjects,
  mockScanDetail,
  mockScans,
  mockTimeline,
} from './mock/data';

export const FORCE_MOCK = process.env.NEXT_PUBLIC_MOCK === '1';
export const ENGINE_BASE = (process.env.NEXT_PUBLIC_GREMLIN_API ?? '').replace(/\/$/, '');
const TIMEOUT_MS = 2500;

export type EngineResult<T> = { kind: 'ok'; data: T } | { kind: 'http'; status: number } | { kind: 'unreachable' };

export async function engineGet<T>(path: string): Promise<EngineResult<T>> {
  if (FORCE_MOCK || !ENGINE_BASE) return { kind: 'unreachable' };
  try {
    const res = await fetch(`${ENGINE_BASE}${path}`, {
      headers: { authorization: `Bearer ${process.env.GREMLIN_API_KEY ?? ''}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return { kind: 'http', status: res.status };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'unreachable' };
  }
}

/** A configured live engine must never silently turn into a simulated demo. */
async function sourced<T>(path: string, pick: (raw: never) => T, mock: () => T, onHttp?: (status: number) => T | null): Promise<Sourced<T> | null> {
  const r = await engineGet<unknown>(path);
  if (r.kind === 'ok') return { data: pick(r.data as never), source: 'engine' };
  if (r.kind === 'http') {
    const v = onHttp?.(r.status);
    return v == null ? null : { data: v, source: 'engine' };
  }
  if (!FORCE_MOCK && ENGINE_BASE) throw new Error('engine_unreachable');
  return { data: mock(), source: 'mock' };
}

/** Signed artifact URLs from the engine are root-relative (/v1/files/...); they carry their own signature, so prefix the engine base URL. */
export const proxied = (u: string | null | undefined): string | null => (u ? (u.startsWith('/') && ENGINE_BASE ? `${ENGINE_BASE}${u}` : u) : null);

export async function listProjects(): Promise<Sourced<ApiProject[]>> {
  return (await sourced<ApiProject[]>('/v1/projects', (r: { projects: ApiProject[] }) => r.projects, mockProjects, () => []))!;
}

export async function listScans(projectId: string): Promise<Sourced<ScanListItem[]>> {
  // Not in the contract yet: GET /v1/projects/:id/scans. Unknown endpoint on a live engine => empty list, not mock.
  return (
    await sourced<ScanListItem[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/scans`,
      (r: { scans: ScanListItem[] }) => r.scans,
      mockScans,
      () => [],
    )
  )!;
}

export async function getScan(id: string): Promise<Sourced<ApiScanDetail> | null> {
  return sourced<ApiScanDetail>(`/v1/scans/${encodeURIComponent(id)}`, (r: ApiScanDetail) => r, () => mockScanDetail(id), () => null);
}

export async function getFinding(id: string): Promise<Sourced<ApiFindingDetail> | null> {
  const res = await sourced<ApiFindingDetail | null>(`/v1/findings/${encodeURIComponent(id)}`, (r: ApiFindingDetail) => r, () => mockFindingDetail(id), () => null);
  if (!res || !res.data) return null;
  const d = res.data;
  return { source: res.source, data: { ...d, screenshotUrls: d.screenshotUrls.map((u) => proxied(u)!), occurrences: d.occurrences.map((o) => ({ ...o, screenshotUrl: proxied(o.screenshotUrl) })) } };
}

export async function getFixPrompt(id: string): Promise<string> {
  const r = await engineGet<string | { prompt: string }>(`/v1/findings/${encodeURIComponent(id)}/prompt`);
  if (r.kind === 'ok') return typeof r.data === 'string' ? r.data : r.data.prompt;
  if (r.kind === 'unreachable' && !FORCE_MOCK && ENGINE_BASE) throw new Error('engine_unreachable');
  return r.kind === 'unreachable' ? mockFixPrompt(id) : '';
}

export async function getTimeline(runId: string): Promise<Sourced<ApiTimeline> | null> {
  const res = await sourced<ApiTimeline>(`/v1/runs/${encodeURIComponent(runId)}/timeline`, (r: ApiTimeline) => r, () => mockTimeline(runId), () => null);
  if (!res) return null;
  const t = res.data;
  return {
    source: res.source,
    data: {
      ...t,
      videoUrl: proxied(t.videoUrl),
      traceUrl: proxied(t.traceUrl),
      rrwebSegments: t.rrwebSegments.map((s) => ({ ...s, signedUrl: proxied(s.signedUrl) ?? s.signedUrl })),
      steps: t.steps.map((s) => ({ ...s, screenshotUrl: proxied(s.screenshotUrl) })),
    },
  };
}

export async function getMetrics(projectId: string): Promise<Sourced<ProjectMetrics | null>> {
  return (await sourced<ProjectMetrics | null>(`/v1/projects/${encodeURIComponent(projectId)}/metrics`, (r: ProjectMetrics) => r, mockMetrics, () => null))!;
}

export { MOCK_PROJECT };

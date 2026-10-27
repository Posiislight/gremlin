'use client';

import { useEffect, useState } from 'react';
import { copyText, sendJson } from '@/lib/client';
import { Btn, StatusPill } from './ui';

type Job = { status: 'idle' | 'running' | 'pr_opened' | 'failed'; log: string[]; prUrl: string | null };

export function FindingActions({ id, status: initial, prompt, mock }: { id: string; status: string; prompt: string; mock: boolean }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [job, setJob] = useState<Job>({ status: 'idle', log: [], prUrl: null });

  useEffect(() => {
    if (mock || job.status !== 'running') return;
    const t = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/gremlin/v1/findings/${encodeURIComponent(id)}/autofix`, { cache: 'no-store' });
        if (res.ok) setJob((await res.json()) as Job);
      } catch { /* keep polling */ }
    }, 2000);
    return () => window.clearInterval(t);
  }, [id, mock, job.status]);

  async function autofix() {
    if (!window.confirm('Let Gremlin fix this bug? A coding agent will change code, run tests, and open a pull request if every check passes.')) return;
    setNote(null);
    const res = await sendJson<Job & { hint?: string }>('POST', `/v1/findings/${encodeURIComponent(id)}/autofix`);
    if (res.ok && res.data) setJob(res.data);
    else setNote(res.status === 503 ? 'auto-fix not configured (set GREMLIN_AUTOFIX_REPRO_CMD on the engine)' : `failed (${res.status || 'network'})`);
  }

  async function set(next: 'confirmed' | 'dismissed' | 'fixed' | 'new') {
    setBusy(true);
    setNote(null);
    const res = mock ? { ok: true, status: 200 } : await sendJson('PATCH', `/v1/findings/${encodeURIComponent(id)}`, { status: next });
    setBusy(false);
    if (res.ok) setStatus(next);
    else setNote(`failed (${res.status || 'network'})`);
  }

  async function copy() {
    const ok = await copyText(prompt);
    setCopied(ok);
    setNote(ok ? null : 'copy failed');
    if (ok) window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mr-1">status</span>
        <StatusPill status={status} />
        {note && <span role="alert" className="font-mono text-[11px] text-p0">{note}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" onClick={copy} disabled={!prompt}>{copied ? 'Copied ✓' : 'Copy fix prompt'}</Btn>
        <Btn variant="primary" onClick={autofix} disabled={mock || job.status === 'running'} title={mock ? 'Needs a live engine' : 'Agent fixes, tests, and opens a PR'}>{job.status === 'running' ? 'Fixing…' : 'Fix this bug'}</Btn>
        <Btn onClick={() => set('confirmed')} disabled={busy || status === 'confirmed'}>Confirm</Btn>
        <Btn onClick={() => set('fixed')} disabled={busy || status === 'fixed'}>Mark fixed</Btn>
        {status === 'dismissed' ? (
          <Btn onClick={() => set('new')} disabled={busy}>Reopen</Btn>
        ) : (
          <Btn variant="danger" onClick={() => set('dismissed')} disabled={busy}>Dismiss</Btn>
        )}
      </div>
      {job.status !== 'idle' && (
        <div className="panel p-3 font-mono text-[11.5px] text-ink-200">
          <div className="label mb-1.5">auto-fix · {job.status === 'pr_opened' ? 'pull request opened' : job.status}</div>
          {job.prUrl && <a href={job.prUrl} target="_blank" rel="noreferrer" className="mb-2 block text-lime hover:underline">{job.prUrl}</a>}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{job.log.slice(-25).join('\n') || 'starting…'}</pre>
        </div>
      )}
    </div>
  );
}

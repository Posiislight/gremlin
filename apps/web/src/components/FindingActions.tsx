'use client';

import { useState } from 'react';
import { copyText, sendJson } from '@/lib/client';
import { Btn, StatusPill } from './ui';

export function FindingActions({ id, status: initial, prompt, mock }: { id: string; status: string; prompt: string; mock: boolean }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
        <Btn onClick={() => set('confirmed')} disabled={busy || status === 'confirmed'}>Confirm</Btn>
        <Btn onClick={() => set('fixed')} disabled={busy || status === 'fixed'}>Mark fixed</Btn>
        {status === 'dismissed' ? (
          <Btn onClick={() => set('new')} disabled={busy}>Reopen</Btn>
        ) : (
          <Btn variant="danger" onClick={() => set('dismissed')} disabled={busy}>Dismiss</Btn>
        )}
      </div>
    </div>
  );
}

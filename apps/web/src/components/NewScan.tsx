'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '@/lib/client';
import { Btn } from './ui';

export function NewScan({ mock, defaultUrl }: { mock: boolean; defaultUrl: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(defaultUrl);
  const [focus, setFocus] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (mock) {
      router.push('/scans/scn_live');
      return;
    }
    setBusy(true);
    const res = await sendJson<{ scanId?: string; error?: string }>('POST', '/v1/scans', {
      url, authorised: true, teamSize: 5, allowedActions: 'read_only', ...(focus ? { focus } : {}),
    });
    setBusy(false);
    if (res.ok && res.data?.scanId) router.push(`/scans/${res.data.scanId}`);
    else setErr(res.data?.error ?? `request failed (${res.status || 'network'})`);
  }

  return (
    <form onSubmit={submit} className="panel grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <label className="grid gap-1">
        <span className="label">target url</span>
        <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://staging.example.com"
          className="h-9 rounded-md border border-ink-600 bg-ink-950 px-3 font-mono text-[13px] text-ink-50 placeholder:text-ink-400 focus:border-lime/60 focus:outline-none" />
      </label>
      <label className="grid gap-1">
        <span className="label">focus (optional)</span>
        <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="checkout, auth, search..."
          className="h-9 rounded-md border border-ink-600 bg-ink-950 px-3 font-mono text-[13px] text-ink-50 placeholder:text-ink-400 focus:border-lime/60 focus:outline-none" />
      </label>
      <Btn type="submit" variant="primary" disabled={!ok || busy} className="h-9 sm:min-w-28">
        {busy ? 'starting…' : 'Run scan'}
      </Btn>
      <label className="flex items-start gap-2 text-[12.5px] text-ink-300 sm:col-span-3">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="mt-0.5 accent-[#b9ff3b]" />
        I am authorised to test this site. The swarm runs read-only by default.
      </label>
      {err && <p role="alert" className="font-mono text-[12px] text-p0 sm:col-span-3">{err}</p>}
    </form>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '@/lib/client';
import { Btn } from './ui';

export function NewScan({ mock, defaultUrl }: { mock: boolean; defaultUrl: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(defaultUrl);
  const [focus, setFocus] = useState('');
  const [full, setFull] = useState(false);
  const [ok, setOk] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
    if (needsLogin) {
      const saved = await sendJson('POST', '/v1/credentials', { url, username, password });
      if (!saved.ok) {
        setBusy(false);
        setErr(`could not save the login (${saved.status || 'network'})`);
        return;
      }
      setPassword('');
    }
    const res = await sendJson<{ scanId?: string; error?: string }>('POST', '/v1/scans', {
      url, authorised: true, teamSize: 1, allowedActions: full ? 'full' : 'read_only', ...(focus ? { focus } : {}),
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
        I am authorised to test this site. Scans run read-only by default.
      </label>
      <label className="flex items-start gap-2 text-[12.5px] text-ink-300 sm:col-span-3">
        <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} className="mt-0.5 accent-[#b9ff3b]" />
        Allow form submissions and other changes on this test site.
      </label>
      <label className="flex items-start gap-2 text-[12.5px] text-ink-300 sm:col-span-3">
        <input type="checkbox" checked={needsLogin} onChange={(e) => setNeedsLogin(e.target.checked)} className="mt-0.5 accent-[#b9ff3b]" />
        This site needs a login. Use a test account.
      </label>
      {needsLogin && (
        <div className="grid gap-3 rounded-md border border-ink-700 bg-ink-900/60 p-3 sm:col-span-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="label">email or username</span>
            <input required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)}
              className="h-9 rounded-md border border-ink-600 bg-ink-950 px-3 font-mono text-[13px] text-ink-50 focus:border-lime/60 focus:outline-none" />
          </label>
          <label className="grid gap-1">
            <span className="label">password</span>
            <input required type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="h-9 rounded-md border border-ink-600 bg-ink-950 px-3 font-mono text-[13px] text-ink-50 focus:border-lime/60 focus:outline-none" />
          </label>
          <p className="text-[11.5px] text-ink-400 sm:col-span-2">Stored encrypted on the engine. The AI agent only sees placeholders, never the real values, and it never appears in replays or findings.</p>
        </div>
      )}
      {err && <p role="alert" className="font-mono text-[12px] text-p0 sm:col-span-3">{err}</p>}
    </form>
  );
}

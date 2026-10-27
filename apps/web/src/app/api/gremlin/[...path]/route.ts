// Server-side proxy: adds the project API key and streams the engine response (JSON, SSE, ranged video, files).
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const base = (process.env.NEXT_PUBLIC_GREMLIN_API ?? '').replace(/\/$/, '');
  if (!base || process.env.NEXT_PUBLIC_MOCK === '1') {
    return Response.json({ error: 'engine_unavailable', mock: true }, { status: 503 });
  }
  const { path } = await ctx.params;
  const target = `${base}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers = new Headers();
  headers.set('authorization', `Bearer ${process.env.GREMLIN_API_KEY ?? ''}`);
  for (const h of ['accept', 'content-type', 'range', 'last-event-id']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      signal: req.signal,
      cache: 'no-store',
    });
    const out = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!HOP.has(k.toLowerCase())) out.set(k, v);
    });
    out.set('cache-control', out.get('content-type')?.includes('event-stream') ? 'no-cache, no-transform' : (out.get('cache-control') ?? 'private, max-age=60'));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return Response.json({ error: 'engine_unreachable' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };

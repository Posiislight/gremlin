import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

/** ~2000 links and ~200 KB of text; generated on demand to keep the repo lean. */
export function hugeHtml(): string {
  const links = Array.from({ length: 2000 }, (_, i) => `<li><a href="/item/${i}">Item link number ${i}</a></li>`).join('\n');
  const para = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ';
  const paras = Array.from({ length: 2000 }, () => `<p>${para}</p>`).join('\n');
  return `<!doctype html><html><head><title>Huge</title></head><body><main><h1>Huge page</h1>\n${paras}\n<ul>\n${links}\n</ul></main></body></html>`;
}

/** 160 elements with 500-char aria-labels and values, plus 40 long alerts. */
export function longHtml(): string {
  const L = (c: string) => c.repeat(500);
  const inputs = Array.from({ length: 160 }, (_, i) => `<input aria-label="${L('n' + (i % 10))}" value="${L('v')}">`).join('\n');
  const alerts = Array.from({ length: 40 }, (_, i) => `<div role="alert">${'alert' + i + ' '.padEnd(1, ' ')}${L('z')}</div>`).join('\n');
  return `<!doctype html><html><head><title>Long</title></head><body><main><h1>Long</h1>
${inputs}\n${alerts}</main></body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** How long /stream keeps its response open after the first chunk. */
export const STREAM_MS = 3000;

export async function startFixtureServer(): Promise<{ url: string; close(): Promise<void>; connections(): number }> {
  let cartCalls = 0;
  let hits = 0;
  let lastCookie: string | null = null;
  let total = 0;
  const timers = new Set<NodeJS.Timeout>();

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'server' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const path = u.pathname;

    // Permissive CORS so cross-origin fixture servers (see hosts.ts) can be read by tests.
    res.setHeader('access-control-allow-origin', '*');
    if (path !== '/api/total' && path !== '/api/hits' && path !== '/api/last-cookie' && path !== '/__reset') total += 1;
    if (method === 'GET' && path === '/api/total') return json(res, 200, { total });
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' });
      res.end();
      return;
    }
    if (path === '/redirect') {
      const status = Number(u.searchParams.get('status') ?? '302');
      res.writeHead(status, { location: u.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    if (path === '/login') {
      res.writeHead(302, { location: '/app/', 'set-cookie': 'sess=fromhop; Path=/' });
      res.end();
      return;
    }
    if (path === '/app/') {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(`<!doctype html><title>app</title><a id="rel" href="next">next</a>
<form id="f" method="post" action="save"><input name="a" value="1"></form>
<script src="app.js"></script>`);
      return;
    }
    if (path === '/app/app.js') {
      res.writeHead(200, { 'content-type': MIME['.js']! });
      res.end(`fetch('data').then(r => r.text()).then(t => { window.fetched = t; });`);
      return;
    }
    if (path === '/app/data') {
      res.writeHead(200, { 'content-type': MIME['.txt']! });
      res.end('APPDATA');
      return;
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (path === '/stream') {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.write('<!doctype html><p id="early">EARLY</p>' + ' '.repeat(2048));
      const t = setTimeout(() => {
        timers.delete(t);
        res.end('<p>late</p>');
      }, STREAM_MS);
      timers.add(t);
      res.on('close', () => {
        clearTimeout(t);
        timers.delete(t);
      });
      return;
    }
    if (path === '/frame') {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(`<!doctype html><img src="/redirect?to=${encodeURIComponent(u.searchParams.get('to') ?? '/')}">`);
      return;
    }
    if (method === 'GET' && path === '/setcookie') {
      res.writeHead(200, { 'set-cookie': 'lax=1; Path=/; SameSite=Lax', 'content-type': MIME['.html']! });
      res.end('ok');
      return;
    }
    if (method === 'GET' && path === '/api/whoami') {
      lastCookie = req.headers.cookie ?? null;
      return json(res, 200, { cookie: lastCookie });
    }
    if (method === 'GET' && path === '/api/last-cookie') return json(res, 200, { cookie: lastCookie });
    if (method === 'POST' && path === '/api/hit') {
      hits += 1;
      return json(res, 200, { hits });
    }
    if (method === 'GET' && path === '/api/hits') return json(res, 200, { hits });
    if (method === 'GET' && path === '/csp.html') {
      const data = await readFile(join(FIXTURES, 'csp.html'));
      res.writeHead(200, { 'content-type': MIME['.html']!, 'content-security-policy': "script-src 'self'" });
      res.end(data);
      return;
    }

    if (method === 'POST' && path === '/__reset') {
      cartCalls = 0;
      hits = 0;
      lastCookie = null;
      total = 0;
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/500') return json(res, 500, { error: 'boom' });
    if (method === 'GET' && path === '/api/ok') return json(res, 200, { ok: true });
    if (method === 'GET' && path === '/api/slow') {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!res.writableEnded) json(res, 200, { ok: true, slow: true });
      }, 6000);
      timers.add(t);
      res.on('close', () => {
        clearTimeout(t);
        timers.delete(t);
      });
      return;
    }
    if (method === 'POST' && path === '/api/echo') {
      const body = await readBody(req);
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/plain' });
      res.end(body);
      return;
    }
    if (method === 'GET' && path === '/api/cart') {
      cartCalls += 1;
      if (cartCalls === 2) return json(res, 500, { error: 'cart unavailable' });
      return json(res, 200, { items: cartCalls });
    }
    if (method === 'GET' && path === '/long.html') {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(longHtml());
      return;
    }
    if (method === 'GET' && path === '/huge.html') {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(hugeHtml());
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      const rel = normalize(path === '/' ? '/index.html' : path);
      const file = join(FIXTURES, rel);
      if (file.startsWith(FIXTURES + sep)) {
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
          res.end(method === 'HEAD' ? undefined : data);
          return;
        } catch {
          /* fall through to 404 */
        }
      }
    }
    res.writeHead(404, { 'content-type': MIME['.html']! });
    res.end('<!doctype html><title>Not found</title><h1>404</h1>');
  }

  let connections = 0;
  server.on('connection', () => (connections += 1)); // raw TCP connections: also counts TLS probes that never form a request
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');

  return {
    url: `http://127.0.0.1:${addr.port}`,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

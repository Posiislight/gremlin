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

export async function startFixtureServer(): Promise<{ url: string; close(): Promise<void> }> {
  let cartCalls = 0;
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

    if (method === 'POST' && path === '/__reset') {
      cartCalls = 0;
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

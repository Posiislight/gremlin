import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Test login accepted by `POST /api/login`; `/store.html` and `POST /api/cart?auth=1` need the resulting cookie. */
export const FIXTURE_LOGIN = { email: 'demo@paddleco.test', password: 'kayak-demo-2026' } as const;
const COOKIE = 'paddle_session=ok';
const signedIn = (cookie: string | undefined) => (cookie ?? '').split(/;\s*/).includes(COOKIE);

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Minimal fixture server for the engine tests: serves `test/fixtures/*.html`, and `POST /api/cart?n=<count>`
 * answers 200 for the first add and 500 from the second on (stateless, so every run sees the same bug).
 */
export async function startFixtureServer(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/api/login' && req.method === 'POST') {
      void readBody(req).then((raw) => {
        let creds: { email?: string; password?: string } = {};
        try {
          creds = req.headers['content-type']?.includes('json')
            ? (JSON.parse(raw) as typeof creds)
            : Object.fromEntries(new URLSearchParams(raw));
        } catch {
          /* fall through to 401 */
        }
        if (creds.email === FIXTURE_LOGIN.email && creds.password === FIXTURE_LOGIN.password) {
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Lax` });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_credentials' }));
        }
      });
      return;
    }
    if (u.pathname === '/api/cart') {
      req.resume();
      if (u.searchParams.get('auth') === '1' && !signedIn(req.headers.cookie)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'sign in required' }));
        return;
      }
      const n = Number(u.searchParams.get('n'));
      const status = n >= 2 ? 500 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: 'cart write failed' }));
      return;
    }
    if (u.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const name = u.pathname.replace(/^\/+/, '');
    if (name === 'store.html' && !signedIn(req.headers.cookie)) {
      res.writeHead(302, { location: '/login.html?next=/store.html' });
      res.end();
      return;
    }
    if (!/^[\w-]+\.(html|css)$/.test(name)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    readFile(join(FIXTURES, name)).then(
      (body) => {
        res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end('not found');
      },
    );
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const { port: boundPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

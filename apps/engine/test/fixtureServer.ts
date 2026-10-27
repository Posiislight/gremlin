import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/**
 * Minimal fixture server for the engine tests: serves `test/fixtures/*.html`, and `POST /api/cart?n=<count>`
 * answers 200 for the first add and 500 from the second on (stateless, so every run sees the same bug).
 */
export async function startFixtureServer(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/api/cart') {
      req.resume();
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
    if (!/^[\w-]+\.html$/.test(name)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    readFile(join(FIXTURES, name)).then(
      (body) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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

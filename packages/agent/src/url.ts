import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM = /^\d+$/;

/** Path only; numeric and UUID segments become `:id`; trailing slash removed. */
export function normalizePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://placeholder.invalid').pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? '/';
  }
  const segs = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (NUM.test(s) || UUID.test(s) ? ':id' : s));
  return '/' + segs.join('/');
}

export function stateHash(path: string, items: { role: string; name: string }[]): string {
  const lines = items.map((i) => `${i.role}:${i.name}`).sort();
  return createHash('sha1')
    .update([path, ...lines].join('\n'))
    .digest('hex');
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

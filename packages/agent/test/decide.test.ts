import { describe, expect, it } from 'vitest';
import { decideRequest, isLoopbackHost, safeUrl, validateOptions, type DecideRequest, type PolicyOptions } from '../src/decide.js';

const base: PolicyOptions = { origin: 'http://127.0.0.1:3000', allowedActions: 'read_only', authAllowlist: [] };
const req = (over: Partial<DecideRequest>): DecideRequest => ({
  url: 'http://127.0.0.1:3000/x',
  method: 'GET',
  resourceType: 'XHR',
  isRedirect: false,
  ...over,
});
const allowed = (r: Partial<DecideRequest>, o: Partial<PolicyOptions> = {}) => decideRequest(req(r), { ...base, ...o }).allow;

describe('payment hosts', () => {
  it.each([
    'https://stripe.com/x',
    'https://checkout.stripe.com/x',
    'https://js.stripe.com/v3',
    'https://stripe.com./x',
    'https://CHECKOUT.Stripe.COM/x',
    'https://paypal.com/x',
    'https://www.paypal.com/x',
    'https://x.y.paypal.com/x',
    'https://adyen.com/x',
    'https://squareup.com/x',
    'https://squareup.com:8443/x',
    'wss://js.stripe.com/s',
  ])('%s is denied in both modes and for every type', (url) => {
    for (const mode of ['read_only', 'full'] as const)
      for (const resourceType of ['Document', 'Image', 'XHR', 'Script', 'WebSocket'])
        expect(allowed({ url, resourceType }, { allowedActions: mode })).toBe(false);
  });
  it.each(['https://notstripe.com/x', 'https://stripe.com.evil.test/x', 'https://mystripe.com/x', 'https://paypal.com.example.test/x'])(
    '%s is not a payment host',
    (url) => {
      expect(allowed({ url, resourceType: 'Image' }, { allowedActions: 'full' })).toBe(true);
    },
  );
  it('redirect hops are judged like any request and the reason says so', () => {
    const d = decideRequest(req({ url: 'https://checkout.stripe.com/x', isRedirect: true }), base);
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toContain('redirect hop');
  });
});

describe('navigation', () => {
  it('denies documents of another site, allows same site and loopback aliases', () => {
    expect(allowed({ url: 'http://foreign.test/', resourceType: 'Document' })).toBe(false);
    expect(allowed({ url: 'http://foreign.test/', resourceType: 'Document' }, { allowedActions: 'full' })).toBe(false);
    expect(allowed({ url: 'http://127.0.0.1:3000/a', resourceType: 'Document' })).toBe(true);
    expect(allowed({ url: 'http://localhost:9999/a', resourceType: 'Document' })).toBe(true);
    expect(allowed({ url: 'http://[::1]:3000/a', resourceType: 'Document' })).toBe(true);
    expect(allowed({ url: 'http://127.0.0.2:3000/a', resourceType: 'Document' })).toBe(true);
    expect(allowed({ url: 'http://app.localhost/a', resourceType: 'Document' })).toBe(true);
  });
  it('allows third-party subresources and extraHosts documents', () => {
    expect(allowed({ url: 'http://cdn.foreign.test/a.js', resourceType: 'Script' })).toBe(true);
    expect(allowed({ url: 'http://foreign.test/', resourceType: 'Document' }, { extraHosts: ['foreign.test'] })).toBe(true);
    expect(allowed({ url: 'http://foreign.test:81/', resourceType: 'Document' }, { extraHosts: ['foreign.test:80'] })).toBe(false);
  });
  it('registrable-domain sites for a non-loopback target', () => {
    const o = { origin: 'https://app.example.com' };
    expect(allowed({ url: 'https://api.example.com/', resourceType: 'Document' }, o)).toBe(true);
    expect(allowed({ url: 'https://example.com/', resourceType: 'Document' }, o)).toBe(true);
    expect(allowed({ url: 'https://example.org/', resourceType: 'Document' }, o)).toBe(false);
    expect(allowed({ url: 'https://other.co.uk/', resourceType: 'Document' }, { origin: 'https://app.example.co.uk' })).toBe(false);
    expect(allowed({ url: 'https://x.example.co.uk/', resourceType: 'Document' }, { origin: 'https://app.example.co.uk' })).toBe(true);
    expect(allowed({ url: 'https://a.github.io/', resourceType: 'Document' }, { origin: 'https://b.github.io' })).toBe(false);
    expect(allowed({ url: 'http://127.0.0.1/', resourceType: 'Document' }, o)).toBe(false);
  });
});

describe('read_only writes', () => {
  it('blocks every mutating method on the target site, allows GET/HEAD and preflights', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'WS']) expect(allowed({ method })).toBe(false);
    for (const method of ['GET', 'HEAD', 'get']) expect(allowed({ method })).toBe(true);
    expect(allowed({ method: 'OPTIONS', resourceType: 'Preflight' })).toBe(true);
    expect(allowed({ method: 'POST', resourceType: 'Document' })).toBe(false);
  });
  it('full mode allows writes', () => {
    expect(allowed({ method: 'POST' }, { allowedActions: 'full' })).toBe(true);
  });
  it('blocks the whole loopback site on any port, but not third parties', () => {
    expect(allowed({ method: 'POST', url: 'http://localhost:1/x' })).toBe(false);
    expect(allowed({ method: 'POST', url: 'http://127.0.0.9:1/x' })).toBe(false);
    expect(allowed({ method: 'POST', url: 'http://[::1]:1/x' })).toBe(false);
    expect(allowed({ method: 'POST', url: 'http://x.localhost/x' })).toBe(false);
    expect(allowed({ method: 'POST', url: 'http://foreign.test/x' })).toBe(true);
  });
  it('extraHosts and apiHosts (host, host:port, *.suffix, [::1]:port) are write-protected', () => {
    const post = (url: string, o: Partial<PolicyOptions>) => allowed({ method: 'POST', url }, o);
    expect(post('http://foreign.test/x', { apiHosts: ['foreign.test'] })).toBe(false);
    expect(post('http://api.foreign.test/x', { apiHosts: ['*.foreign.test'] })).toBe(false);
    expect(post('http://foreign.test/x', { apiHosts: ['*.foreign.test'] })).toBe(true);
    expect(post('http://foreign.test:8080/x', { apiHosts: ['foreign.test:8080'] })).toBe(false);
    expect(post('http://foreign.test:8081/x', { apiHosts: ['foreign.test:8080'] })).toBe(true);
    expect(post('http://foreign.test/x', { extraHosts: ['foreign.test'] })).toBe(false);
    expect(post('http://third.test/x', { origin: 'http://app.example.test', apiHosts: ['[::1]:3000'] })).toBe(true);
    expect(post('http://[::1]:3000/x', { origin: 'http://app.example.test', apiHosts: ['[::1]:3000'] })).toBe(false);
    expect(post('http://[::1]:3001/x', { origin: 'http://app.example.test', apiHosts: ['[::1]:3000'] })).toBe(true);
    expect(post('http://[::1]/x', { origin: 'http://app.example.test', extraHosts: ['[::1]'] })).toBe(false);
  });
  it('subdomain of the target registrable domain is the target site', () => {
    expect(allowed({ method: 'POST', url: 'http://api.example.test/x' }, { origin: 'http://app.example.test' })).toBe(false);
  });
  it('auth allowlist matches on segment boundaries', () => {
    const o = { authAllowlist: ['/api/login', '/auth/'] };
    const post = (path: string) => allowed({ method: 'POST', url: `http://127.0.0.1:3000${path}` }, o);
    expect(post('/api/login')).toBe(true);
    expect(post('/api/login/step2')).toBe(true);
    expect(post('/auth/x')).toBe(true);
    expect(post('/api/loginx')).toBe(false);
    expect(post('/api/login-history/delete')).toBe(false);
    expect(post('/auth')).toBe(false);
    expect(post('/api')).toBe(false);
  });
  it('WebSocket handshakes follow the same rules', () => {
    expect(allowed({ method: 'WS', url: 'ws://127.0.0.1:3000/ws', resourceType: 'WebSocket' })).toBe(false);
    expect(allowed({ method: 'WS', url: 'ws://127.0.0.1:3000/ws', resourceType: 'WebSocket' }, { allowedActions: 'full' })).toBe(true);
    expect(allowed({ method: 'WS', url: 'wss://foreign.test/ws', resourceType: 'WebSocket' })).toBe(true);
  });
});

describe('helpers', () => {
  it('non-http schemes and unparsable URLs are not judged', () => {
    expect(allowed({ url: 'data:text/plain,hi', method: 'POST' })).toBe(true);
    expect(allowed({ url: 'not a url' })).toBe(true);
  });
  it('isLoopbackHost', () => {
    for (const h of ['localhost', 'LOCALHOST.', 'a.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['128.0.0.1', '127.0.0', 'localhost.evil.test', '10.0.0.1']) expect(isLoopbackHost(h), h).toBe(false);
  });
  it('validateOptions rejects bad allowlist entries', () => {
    for (const bad of ['', '/', 'api']) expect(() => validateOptions({ authAllowlist: [bad] })).toThrow(/authAllowlist/);
    expect(() => validateOptions({ authAllowlist: ['/api/login'] })).not.toThrow();
  });
  it('safeUrl strips query and fragment only when asked', () => {
    expect(safeUrl('http://a.test/p?token=1#h', true)).toEqual({ url: 'http://a.test/p', hadQuery: true });
    expect(safeUrl('http://a.test/p?token=1', false)).toEqual({ url: 'http://a.test/p?token=1', hadQuery: true });
    expect(safeUrl('http://a.test/p', true)).toEqual({ url: 'http://a.test/p', hadQuery: false });
  });
});

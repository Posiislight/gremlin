import { describe, expect, it } from 'vitest';
import { normalizePath, sameOrigin, stateHash } from '../src/url.js';

describe('normalizePath', () => {
  it('replaces numeric and uuid segments and strips trailing slash', () => {
    expect(
      normalizePath('https://a.com/orders/123/items/9f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c/'),
    ).toBe('/orders/:id/items/:id');
  });
  it('keeps root as /', () => {
    expect(normalizePath('https://a.com')).toBe('/');
    expect(normalizePath('https://a.com/?q=1#x')).toBe('/');
  });
  it('drops query and hash', () => {
    expect(normalizePath('https://a.com/cart?x=1#top')).toBe('/cart');
  });
});

describe('stateHash', () => {
  const a = { role: 'button', name: 'Add' };
  const b = { role: 'link', name: 'Home' };
  it('is order-independent', () => {
    expect(stateHash('/x', [a, b])).toBe(stateHash('/x', [b, a]));
  });
  it('changes with path or items', () => {
    expect(stateHash('/x', [a])).not.toBe(stateHash('/y', [a]));
    expect(stateHash('/x', [a])).not.toBe(stateHash('/x', [a, b]));
  });
  it('is sha1 hex', () => {
    expect(stateHash('/', [])).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('sameOrigin', () => {
  it('compares origins', () => {
    expect(sameOrigin('http://a.com/x', 'http://a.com/y')).toBe(true);
    expect(sameOrigin('http://a.com/x', 'https://a.com/x')).toBe(false);
    expect(sameOrigin('http://a.com:81/', 'http://a.com/')).toBe(false);
    expect(sameOrigin('nonsense', 'http://a.com/')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { Action } from '../src/index.js';

const i = { intent: 'why' };
const valid: Record<string, unknown>[] = [
  { type: 'click', ref: 'e1' },
  { type: 'type', ref: 'e1', text: 'hi', submit: true },
  { type: 'select', ref: 'e1', option: 'A' },
  { type: 'press', key: 'Enter' },
  { type: 'hover', ref: 'e1' },
  { type: 'scroll', direction: 'down' },
  { type: 'upload', ref: 'e1', fixture: 'a.png' },
  { type: 'goto', path: '/shop' },
  { type: 'back' },
  { type: 'refresh' },
  { type: 'wait', ms: 3000 },
  { type: 'expect', statement: 'cart shows 1' },
  { type: 'report_bug', title: 't', expected: 'e', actual: 'a', severityHint: 'P1' },
  { type: 'finish', reason: 'done' },
];

describe('Action', () => {
  it.each(valid)('parses %o', (a) => {
    expect(Action.parse({ ...a, ...i })).toMatchObject(a);
  });
  it('covers all 14 types', () => {
    expect(new Set(valid.map((a) => a.type)).size).toBe(14);
  });
  it('rejects wait over 3000ms', () => {
    expect(Action.safeParse({ type: 'wait', ms: 5000, ...i }).success).toBe(false);
  });
  it('rejects absolute and protocol-relative goto', () => {
    expect(Action.safeParse({ type: 'goto', path: 'https://evil.com', ...i }).success).toBe(false);
    expect(Action.safeParse({ type: 'goto', path: '//evil.com', ...i }).success).toBe(false);
  });
  it('rejects unknown type and missing intent', () => {
    expect(Action.safeParse({ type: 'explode', ...i }).success).toBe(false);
    expect(Action.safeParse({ type: 'back' }).success).toBe(false);
  });
});

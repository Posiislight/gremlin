import { describe, expect, it } from 'vitest';
import { redact, resolvePlaceholders } from '../src/secrets.js';

describe('resolvePlaceholders', () => {
  it('substitutes named secrets and persona keys', () => {
    expect(resolvePlaceholders('{{password}}', { password: 'hunter2' })).toBe('hunter2');
    expect(resolvePlaceholders('u={{persona:admin.email}}!', { 'persona:admin.email': 'a@b.c' })).toBe('u=a@b.c!');
  });

  it('does not rescan substituted values', () => {
    expect(resolvePlaceholders('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
  });

  it('fuzz kinds have exact values', () => {
    const f = (k: string) => resolvePlaceholders(`{{fuzz:${k}}}`, {});
    expect(f('empty')).toBe('');
    expect(f('whitespace')).toBe('   ');
    expect(f('long')).toBe('a'.repeat(5000));
    expect(f('long')).toHaveLength(5000);
    expect(f('unicode')).toBe('😀 Ünïcödé 漢字');
    expect(f('rtl')).toBe('مرحبا بالعالم');
    expect(f('negative')).toBe('-1');
    expect(f('zero')).toBe('0');
    expect(f('huge')).toBe('99999999999999999999');
    expect(f('quotes')).toBe(`'"<>`);
  });

  it('unknown placeholders throw naming the placeholder, not secret values', () => {
    expect(() => resolvePlaceholders('{{nope}}', { password: 'hunter2' })).toThrow(/\{\{nope\}\}/);
    expect(() => resolvePlaceholders('{{fuzz:wat}}', { password: 'hunter2' })).toThrow(/fuzz:wat/);
    try {
      resolvePlaceholders('{{nope}}', { password: 'hunter2' });
    } catch (e) {
      expect(String(e)).not.toContain('hunter2');
    }
  });

  it('leaves text without placeholders alone', () => {
    expect(resolvePlaceholders('plain {text}', {})).toBe('plain {text}');
  });
});

describe('redact', () => {
  it('replaces secret values, longest first, skipping empties', () => {
    expect(redact('x hunter2 y', { password: 'hunter2' })).toBe('x ••• y');
    expect(redact('abc abcd', { a: 'abc', b: 'abcd', c: '' })).toBe('••• •••');
    expect(redact('keep', { e: '' })).toBe('keep');
  });
});

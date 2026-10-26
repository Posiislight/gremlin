const FUZZ: Record<string, string> = {
  empty: '',
  whitespace: '   ',
  long: 'a'.repeat(5000),
  unicode: '😀 Ünïcödé 漢字',
  rtl: 'مرحبا بالعالم',
  negative: '-1',
  zero: '0',
  huge: '99999999999999999999',
  quotes: `'"<>`,
};

/** Resolve `{{name}}`, `{{persona:x.y}}` and `{{fuzz:<kind>}}`. Unknown placeholders throw (naming only the placeholder). */
export function resolvePlaceholders(text: string, secrets: Record<string, string>): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, key: string) => {
    if (key.startsWith('fuzz:')) {
      const kind = key.slice(5);
      if (Object.hasOwn(FUZZ, kind)) return FUZZ[kind]!;
    } else if (Object.hasOwn(secrets, key)) {
      return secrets[key]!;
    }
    throw new Error(`unknown placeholder {{${key}}}`);
  });
}

/** Replace every secret value (longest first, empties skipped) with a mask. */
export function redact(text: string, secrets: Record<string, string>): string {
  const values = Object.values(secrets)
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('•••');
  return out;
}

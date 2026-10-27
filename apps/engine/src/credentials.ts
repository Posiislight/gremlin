import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { environments, personas, type Db } from '@gremlin/db';

export const DEFAULT_PERSONA = 'default';
export const CREDENTIAL_LINK_TTL_S = 15 * 60;

export type StoredCredentials = { username: string; password: string };

function key(secret: string): Buffer {
  return createHash('sha256').update(`gremlin-credentials:${secret}`).digest();
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encryptCredentials(creds: StoredCredentials, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptCredentials(blob: string, secret: string): StoredCredentials {
  const raw = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(text) as Partial<StoredCredentials>;
  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') throw new Error('bad credentials blob');
  return { username: parsed.username, password: parsed.password };
}

export type LinkClaims = { projectId: string; environmentId: string; persona: string };

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(`cred-link:${payload}`).digest('base64url');

/** Short-lived, HMAC-signed token that authorises one browser form to store credentials for one environment. */
export function signCredentialLink(claims: LinkClaims, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + CREDENTIAL_LINK_TTL_S })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyCredentialLink(token: string, secret: string, now = Date.now()): LinkClaims | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const want = Buffer.from(sign(payload, secret));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LinkClaims & { exp?: number };
    if (typeof c.exp !== 'number' || c.exp * 1000 < now) return null;
    if (!c.projectId || !c.environmentId || !c.persona) return null;
    return { projectId: c.projectId, environmentId: c.environmentId, persona: c.persona };
  } catch {
    return null;
  }
}

export async function saveCredentials(db: Db, environmentId: string, persona: string, creds: StoredCredentials, secret: string): Promise<void> {
  const enc = encryptCredentials(creds, secret);
  const [existing] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.environmentId, environmentId), eq(personas.name, persona)))
    .limit(1);
  if (existing) await db.update(personas).set({ credentialsEnc: enc }).where(eq(personas.id, existing.id));
  else await db.insert(personas).values({ environmentId, name: persona, credentialsEnc: enc });
}

/** The project's environment for a URL's origin, created (read_only) if it does not exist yet. */
export async function ensureEnvironment(db: Db, projectId: string, url: string): Promise<string> {
  const origin = new URL(url).origin;
  const [existing] = await db.select({ id: environments.id }).from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.baseUrl, origin))).limit(1);
  if (existing) return existing.id;
  const [env] = await db.insert(environments).values({ projectId, baseUrl: origin, allowedActions: 'read_only' }).returning({ id: environments.id });
  return env!.id;
}

/** Names of personas with stored credentials for an environment (never the values). */
export async function savedPersonaNames(db: Db, environmentId: string): Promise<string[]> {
  const rows = await db.select({ name: personas.name, enc: personas.credentialsEnc }).from(personas).where(eq(personas.environmentId, environmentId));
  return rows.filter((r) => r.enc).map((r) => r.name);
}

/** Placeholder values for `{{username}}` / `{{password}}` (and `{{email}}`) for an agent run, or {} if none are stored. */
export async function loadSecrets(db: Db, environmentId: string, persona: string | undefined, secret: string): Promise<Record<string, string>> {
  const rows = await db.select({ name: personas.name, enc: personas.credentialsEnc }).from(personas).where(eq(personas.environmentId, environmentId));
  const withCreds = rows.filter((r) => r.enc);
  const row = withCreds.find((r) => r.name === persona) ?? withCreds.find((r) => r.name === DEFAULT_PERSONA) ?? withCreds[0];
  if (!row?.enc) return {};
  try {
    const c = decryptCredentials(row.enc, secret);
    return { username: c.username, email: c.username, password: c.password };
  } catch {
    return {};
  }
}

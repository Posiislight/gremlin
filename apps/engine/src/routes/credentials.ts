import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { environments, type Db } from '@gremlin/db';
import { saveCredentials, verifyCredentialLink } from '../credentials.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const body = z.object({ username: z.string().min(1).max(320), password: z.string().min(1).max(512) });

const PAGE_CSS = `
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8eaf0;font:16px/1.5 system-ui,sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:#141824;border:1px solid #262c3d;border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{color:#9aa3b8;margin:0 0 18px;font-size:14px}
label{display:block;font-size:13px;color:#b7bfd3;margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #2d3550;background:#0e1220;color:#fff;font-size:15px}
input:focus{outline:2px solid #7c5cff;border-color:transparent}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:10px;background:#7c5cff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.note{margin-top:16px;font-size:12px;color:#7d86a0}.ok{color:#5fd68a}.err{color:#ff7a8a;font-size:13px;margin-top:10px}`;

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main class="card">${inner}</main></body></html>`;
}

function send(reply: FastifyReply, status: number, html: string) {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    .send(html);
}

const expired = (reply: FastifyReply) =>
  send(reply, 410, page('Link expired', `<h1>This link has expired</h1><p>Ask Alan to request credentials again to get a fresh link.</p>`));

/**
 * Public (token-authenticated) pages where a person enters a site login directly into Gremlin, so the password never
 * passes through the chat or the model. Stored AES-256-GCM encrypted; agents only ever see `{{username}}`/`{{password}}`.
 */
export function credentialRoutes(deps: { db: Db; secret: string }) {
  const { db, secret } = deps;
  return async function (app: FastifyInstance): Promise<void> {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_req, raw, done) => {
      done(null, Object.fromEntries(new URLSearchParams(raw as string)));
    });

    const form = async (token: string, error?: string) => {
      const claims = verifyCredentialLink(token, secret);
      if (!claims) return null;
      const [env] = await db.select().from(environments).where(eq(environments.id, claims.environmentId)).limit(1);
      if (!env || env.projectId !== claims.projectId) return null;
      return page(
        'Add a test login',
        `<h1>Add a test login</h1><p>Gremlin will use this to sign in to <strong>${esc(env.baseUrl)}</strong> while it tests. Use a test account, not your real one.</p>
<form method="post" autocomplete="off">
<label for="u">Email or username</label><input id="u" name="username" required maxlength="320" autocomplete="off" autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" required maxlength="512" autocomplete="new-password">
${error ? `<div class="err">${esc(error)}</div>` : ''}
<button type="submit">Save login</button></form>
<p class="note">Stored encrypted. It is never shown to the AI model or written to logs, replays or findings. This link expires in 15 minutes.</p>`,
      );
    };

    app.get<{ Params: { token: string } }>('/credentials/:token', async (req, reply) => {
      const html = await form(req.params.token);
      return html ? send(reply, 200, html) : expired(reply);
    });

    app.post<{ Params: { token: string } }>('/credentials/:token', async (req, reply) => {
      const claims = verifyCredentialLink(req.params.token, secret);
      if (!claims) return expired(reply);
      const parsed = body.safeParse(req.body);
      if (!parsed.success) {
        const html = await form(req.params.token, 'Enter both an email/username and a password.');
        return html ? send(reply, 400, html) : expired(reply);
      }
      const [env] = await db.select().from(environments).where(eq(environments.id, claims.environmentId)).limit(1);
      if (!env || env.projectId !== claims.projectId) return expired(reply);
      await saveCredentials(db, env.id, claims.persona, parsed.data, secret);
      return send(reply, 200, page('Login saved', `<h1 class="ok">Login saved</h1><p>You can close this tab and go back to Alan. Tell it you've added the login.</p>`));
    });
  };
}

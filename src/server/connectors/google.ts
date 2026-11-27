// Google: one connector for Calendar now and Gmail later. OAuth for installed
// apps, with plain fetch (no googleapis):
// - Your own Desktop-app client (ID + secret from Settings, typed or read from
//   the JSON Google Cloud gives you).
// - A loopback redirect back to the hub on 127.0.0.1.
// - PKCE (S256) and a one-time state value, kept in memory for 10 minutes.
// - access_type=offline and prompt=consent, so Google always returns a refresh token.
// The refresh token goes to the Keychain; access tokens stay in memory.
//
// Apps left in "Testing" on Google's consent screen get refresh tokens that
// expire after 7 days. Google then answers invalid_grant, which marks the
// connector "needs reconnect" (AuthRejected). Nothing retries.
import crypto from 'node:crypto';
import { AuthRejected, ConnectorError, type Connector, type ConnectorContext } from './types.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
/** Only Calendar events for now; Gmail's read-only scope gets added later. */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

const STATE_TTL_MS = 10 * 60_000;
const b64url = (b: Buffer) => b.toString('base64url');

/** The redirect Google sends you back to. Desktop-app clients accept any loopback port. */
export const redirectUri = (origin: string, id = 'google') => `${origin}/oauth/${id}/callback`;

/**
 * Reads a client JSON downloaded from Google Cloud ("installed" for Desktop
 * apps) and returns only the client ID and secret. Everything else is dropped.
 */
export function readClientFile(json: unknown): { 'client-id': string; 'client-secret': string } {
  if (!json || typeof json !== 'object') throw new ConnectorError('bad-file', "That isn't a Google client JSON file.");
  const o = json as Record<string, unknown>;
  if (o.web && !o.installed) throw new ConnectorError('bad-file', 'That file is for a "Web application" client. Create a "Desktop app" client in Google Cloud and download its JSON instead.');
  const inst = o.installed as Record<string, unknown> | undefined;
  const id = inst?.client_id;
  const secret = inst?.client_secret;
  if (typeof id !== 'string' || !/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(id) || typeof secret !== 'string' || secret.length < 8 || secret.length > 200) {
    throw new ConnectorError('bad-file', "That file doesn't hold a Desktop-app client ID and secret.");
  }
  return { 'client-id': id, 'client-secret': secret };
}

type TokenAnswer = { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string };

export type GoogleConnector = Connector & {
  /** A fresh access token, refreshing it with the saved refresh token when needed. */
  accessToken(ctx: ConnectorContext): Promise<string>;
  /** A Google API call with the access token; one refresh-and-retry on 401. */
  api(ctx: ConnectorContext, url: string, init?: RequestInit): Promise<Response>;
};

export function googleConnector(opts: { onSync?: (ctx: ConnectorContext, g: GoogleConnector) => Promise<{ account?: string | null } | void> } = {}): GoogleConnector {
  const pending = new Map<string, { verifier: string; at: number; returnTo: string }>();
  let access: { token: string; until: number } | null = null;

  async function tokenRequest(ctx: ConnectorContext, form: Record<string, string>): Promise<TokenAnswer & { status: number }> {
    const res = await ctx.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as TokenAnswer;
    return { ...body, status: res.status };
  }

  async function client(ctx: ConnectorContext) {
    const id = ctx.getSetting('client-id');
    const secret = await ctx.secrets.get('client-secret');
    if (typeof id !== 'string' || !id || !secret) throw new ConnectorError('not-ready', 'Save the Google client ID and secret first.');
    return { id, secret };
  }

  const g: GoogleConnector = {
    id: 'google',
    name: 'Google Calendar',
    description: 'Shows your primary calendar on the Today page and adds the reminders you confirm. Uses your own Google Cloud "Desktop app" client.',
    sends:
      "Connecting opens Google's sign-in page. After that it reads events on your primary calendar from today through 14 days out (at start, every 10 minutes and on Sync now), and creates or deletes only the events you confirm or undo. It keeps each event's title, times, link and linked project, nothing else.",
    fields: [
      {
        key: 'client-id',
        label: 'Client ID',
        secret: false,
        placeholder: '…apps.googleusercontent.com',
        check: (v) => (/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(v) ? null : 'A Google client ID ends in ".apps.googleusercontent.com".'),
      },
      {
        key: 'client-secret',
        label: 'Client secret',
        secret: true,
        help: 'Stored in the macOS Keychain.',
        check: (v) => (v.length >= 8 && v.length <= 200 && !/\s/.test(v) ? null : "That doesn't look like a Google client secret."),
      },
    ],
    required: ['client-id', 'client-secret'],
    importFile: readClientFile,
    syncEveryMs: 10 * 60_000,
    syncOnStart: true,

    async connect(ctx, { returnTo = '/settings#connections' } = {}) {
      const { id } = await client(ctx);
      const now = ctx.now().getTime();
      for (const [k, v] of pending) if (now - v.at > STATE_TTL_MS) pending.delete(k);
      const state = b64url(crypto.randomBytes(32));
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      pending.set(state, { verifier, at: now, returnTo });
      const q = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri(ctx.origin),
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return { kind: 'redirect', url: `${GOOGLE_AUTH_URL}?${q}` };
    },

    async callback(ctx, params) {
      const state = params.get('state') ?? '';
      const p = pending.get(state);
      // One use only, and only within 10 minutes.
      pending.delete(state);
      if (!p || ctx.now().getTime() - p.at > STATE_TTL_MS) throw new ConnectorError('bad-state', 'That sign-in link expired or was already used. Click Connect again.');
      const returnTo = p.returnTo;
      const err = params.get('error');
      if (err) throw Object.assign(new ConnectorError(err === 'access_denied' ? 'denied' : 'google-error', err === 'access_denied' ? 'You cancelled the Google sign-in.' : 'Google refused the sign-in.'), { returnTo });
      const code = params.get('code');
      if (!code) throw Object.assign(new ConnectorError('google-error', 'Google sent no sign-in code.'), { returnTo });
      const { id, secret } = await client(ctx);
      const t = await tokenRequest(ctx, { client_id: id, client_secret: secret, code, code_verifier: p.verifier, grant_type: 'authorization_code', redirect_uri: redirectUri(ctx.origin) });
      if (t.status !== 200 || !t.access_token) {
        const msg = t.error === 'invalid_client' ? 'Google rejected the client ID or secret. Check them and connect again.' : `Google refused to finish the sign-in (${t.error ?? t.status}).`;
        throw Object.assign(new ConnectorError('token', msg), { returnTo });
      }
      if (!t.refresh_token) throw Object.assign(new ConnectorError('no-refresh', "Google didn't return a refresh token. Connect again."), { returnTo });
      const granted = (t.scope ?? '').split(' ');
      if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) {
        throw Object.assign(new ConnectorError('scope', 'Calendar access was not granted. Connect again and tick the calendar box.'), { returnTo });
      }
      await ctx.secrets.set('refresh-token', t.refresh_token);
      access = { token: t.access_token, until: ctx.now().getTime() + Math.max(0, (t.expires_in ?? 0) - 60) * 1000 };
      return { account: null, returnTo };
    },

    async disconnect(ctx) {
      const rt = await ctx.secrets.get('refresh-token');
      access = null;
      await ctx.secrets.delete('refresh-token');
      // Tell Google too, so the token stops working everywhere. Best effort.
      if (rt) await ctx.fetch(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }).toString(), signal: AbortSignal.timeout(10_000) }).catch(() => {});
    },

    async accessToken(ctx) {
      if (access && access.until > ctx.now().getTime()) return access.token;
      const rt = await ctx.secrets.get('refresh-token');
      if (!rt) throw new AuthRejected('The Google sign-in is missing. Reconnect.');
      const { id, secret } = await client(ctx);
      const t = await tokenRequest(ctx, { client_id: id, client_secret: secret, refresh_token: rt, grant_type: 'refresh_token' });
      if (t.error === 'invalid_grant') {
        access = null;
        throw new AuthRejected('Google no longer accepts the saved sign-in. While the Google app is in Testing this happens every 7 days. Reconnect to continue.');
      }
      if (t.error === 'invalid_client') throw new ConnectorError('invalid-client', 'Google rejected the client ID or secret.');
      if (t.status !== 200 || !t.access_token) throw new ConnectorError('token', `Google's token service answered ${t.status}. It will try again at the next sync.`);
      access = { token: t.access_token, until: ctx.now().getTime() + Math.max(0, (t.expires_in ?? 0) - 60) * 1000 };
      return access.token;
    },

    async api(ctx, url, init = {}) {
      const call = async () =>
        ctx.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await g.accessToken(ctx)}` }, signal: AbortSignal.timeout(20_000) });
      let res = await call();
      if (res.status === 401) {
        // The access token may have been revoked early: refresh once, then give up.
        access = null;
        res = await call();
        if (res.status === 401) throw new AuthRejected('Google no longer accepts the saved sign-in. Reconnect to continue.');
      }
      return res;
    },

    async sync(ctx) {
      return opts.onSync?.(ctx, g);
    },
  };
  return g;
}

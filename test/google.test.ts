// Google connector and calendar (Today page, phase 2), against a fake Google
// behind a mocked fetch: OAuth with PKCE and state, the client JSON upload,
// refresh and "needs reconnect", sync into the cache, and createEvent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { checkRepeat, normalizeEvent, DEFAULTS, dateOnly, addDays, startOfDay, type CalendarService } from '../src/server/calendar.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { googleConnector, readClientFile, GOOGLE_SCOPES } from '../src/server/connectors/google.ts';
import { googleCalendarBackend } from '../src/server/connectors/google-calendar.ts';
import { openDb } from '../src/server/db/index.ts';
import { settings } from '../src/server/db/schema.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Built from pieces so this file never holds a whole secret-shaped string.
const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOC' + 'SPX-testtesttesttest';
const REFRESH = '1/' + '/0gTESTREFRESHTOKENxx';
const ACCESS = 'ya' + '29.TESTACCESSTOKENxxxxxx';
const PAGE_WRITE = { ...PAGE_GET, Origin: HUB, 'Content-Type': 'application/json' };

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

/** A fake Google: token endpoint, events list/insert/delete. Records every call. */
function fakeGoogle() {
  const calls: Call[] = [];
  const g = {
    calls,
    refreshValid: true,
    tokenAnswers: 0,
    events: [] as Record<string, unknown>[],
    listStatus: 200,
    listBody: null as unknown,
    lastInsert: null as Record<string, unknown> | null,
    fetch: (async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body = typeof init.body === 'string' ? init.body : '';
      calls.push({ url, method: init.method ?? 'GET', body, headers: (init.headers ?? {}) as Record<string, string> });
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === 'https://oauth2.googleapis.com/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code') {
          g.tokenAnswers++;
          return json({ access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH, scope: GOOGLE_SCOPES.join(' '), token_type: 'Bearer' });
        }
        if (!g.refreshValid) return json({ error: 'invalid_grant', error_description: `Token has been expired or revoked. ${REFRESH}` }, 400);
        return json({ access_token: ACCESS, expires_in: 3600 });
      }
      if (url === 'https://oauth2.googleapis.com/revoke') return json({});
      if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
        const m = init.method ?? 'GET';
        if (m === 'GET') return g.listBody ? json(g.listBody, g.listStatus) : json({ summary: 'someone@example.com', items: g.events }, g.listStatus);
        if (m === 'POST') {
          const b = JSON.parse(body);
          g.lastInsert = b;
          return json({ id: 'new1', status: 'confirmed', htmlLink: 'https://www.google.com/calendar/event?eid=new1', ...b });
        }
        if (m === 'DELETE') return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
  };
  return g;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-google-'));
  dirs.push(dir);
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const fake = fakeGoogle();
  let calendar!: CalendarService;
  const google = googleConnector({ onSync: async () => ({ account: (await calendar.sync()).account }) });
  const t = testDeps(db, { connectors: [google], fetch: fake.fetch, calendarBackend: (reg) => googleCalendarBackend(reg, google) });
  calendar = t.calendar;
  fs.writeFileSync(t.projectsFile, 'projects:\n  - slug: demo\n    name: Demo\n');
  t.store.reload();
  const app = createApp(t.deps);
  const req = (p: string, init: RequestInit = {}) => app.request(`${HUB}${p}`, init);
  return { db, t, fake, req, google };
}

const clientFile = { installed: { client_id: CLIENT_ID, project_id: 'my-project-123', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: CLIENT_SECRET, redirect_uris: ['http://localhost'] } };

/** Uploads the client JSON, clicks Connect, and follows Google's redirect back with a code. */
async function connect(s: ReturnType<typeof setup>, returnTo?: string) {
  await s.req('/api/connectors/google/import', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(clientFile) });
  const r = await (await s.req('/api/connectors/google/connect', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(returnTo ? { returnTo } : {}) })).json();
  const auth = new URL(r.redirect);
  const back = await s.req(`/oauth/google/callback?state=${auth.searchParams.get('state')}&code=test-code&scope=${encodeURIComponent(GOOGLE_SCOPES[0])}`);
  return { auth, back };
}

describe('client JSON upload', () => {
  it('keeps only the client ID (settings) and secret (Keychain)', async () => {
    const s = setup();
    const r = await s.req('/api/connectors/google/import', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(clientFile) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(CLIENT_SECRET);
    expect(JSON.parse(text)).toMatchObject({ canConnect: true, fields: [{ key: 'client-id', saved: true, value: CLIENT_ID }, { key: 'client-secret', saved: true, value: null }] });
    expect(s.t.secrets.dump()).toEqual({ 'google.client-secret': CLIENT_SECRET });
    expect(s.db.select().from(settings).all().map((r) => [r.key, r.value])).toEqual([['connector.google.client-id', CLIENT_ID]]);
    expect(s.fake.calls).toEqual([]);
  });

  it('refuses a Web application client or a file without the fields', () => {
    expect(() => readClientFile({ web: clientFile.installed })).toThrow('Desktop app');
    expect(() => readClientFile({ installed: { client_id: 'nope' } })).toThrow("doesn't hold");
    expect(() => readClientFile('x')).toThrow();
  });

  it('refuses uploads from other origins', async () => {
    const s = setup();
    const r = await s.req('/api/connectors/google/import', { method: 'POST', headers: { ...PAGE_WRITE, Origin: 'https://evil.example.com' }, body: JSON.stringify(clientFile) });
    expect(r.status).toBe(403);
    expect(s.t.secrets.dump()).toEqual({});
  });
});

describe('OAuth', () => {
  it('asks for offline calendar.events access with PKCE and state, then trades the code', async () => {
    const s = setup();
    s.fake.events = [];
    const { auth, back } = await connect(s, '/today');
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = auth.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:4747/oauth/google/callback');
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('include_granted_scopes')).toBe('true');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // No client secret in the browser's URL.
    expect(auth.toString()).not.toContain(CLIENT_SECRET);

    expect(back.status).toBe(302);
    expect(back.headers.get('Location')).toBe('/today?connected=google&ok=1');
    const exchange = new URLSearchParams(s.fake.calls.find((c) => c.url.endsWith('/token'))!.body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    const challenge = crypto.createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url');
    expect(challenge).toBe(q.get('code_challenge'));
    expect(s.t.secrets.dump()['google.refresh-token']).toBe(REFRESH);
    // Connected, then synced once: the account is the primary calendar's summary.
    const st = await s.t.connectors.status('google');
    expect(st).toMatchObject({ state: 'connected', account: 'someone@example.com', error: null });
  });

  it('refuses an unknown or reused state, without calling Google', async () => {
    const s = setup();
    let back = await s.req('/oauth/google/callback?state=forged&code=x');
    expect(back.headers.get('Location')).toBe('/settings?connected=google&ok=0#connections');
    expect(s.fake.calls).toEqual([]);
    const { auth } = await connect(s);
    const calls = s.fake.calls.length;
    back = await s.req(`/oauth/google/callback?state=${auth.searchParams.get('state')}&code=again`);
    expect(back.headers.get('Location')).toContain('ok=0');
    expect(s.fake.calls.length).toBe(calls);
  });

  it('a cancelled sign-in keeps the state and shows why', async () => {
    const s = setup();
    await s.req('/api/connectors/google/import', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(clientFile) });
    const r = await (await s.req('/api/connectors/google/connect', { method: 'POST', headers: PAGE_WRITE, body: '{}' })).json();
    const state = new URL(r.redirect).searchParams.get('state');
    await s.req(`/oauth/google/callback?state=${state}&error=access_denied`);
    expect(await s.t.connectors.status('google')).toMatchObject({ state: 'not-set-up', error: 'You cancelled the Google sign-in.' });
  });

  it('Connect only accepts the hub\'s own pages to return to', async () => {
    const s = setup();
    await s.req('/api/connectors/google/import', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(clientFile) });
    const r = await s.req('/api/connectors/google/connect', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ returnTo: 'https://evil.example.com' }) });
    expect(r.status).toBe(400);
  });
});

describe('refresh token rejected', () => {
  it('a sync that hits invalid_grant shows Reconnect, keeps the cache, and never retries', async () => {
    const s = setup();
    s.fake.events = [{ id: 'e1', summary: 'Standup', start: { dateTime: new Date(Date.now() + 3600_000).toISOString() }, end: { dateTime: new Date(Date.now() + 5400_000).toISOString() } }];
    await connect(s);
    expect(s.t.calendar.list()).toHaveLength(1);
    // The next request needs a new access token, and Google refuses the refresh token.
    s.fake.listStatus = 401;
    s.fake.refreshValid = false;
    const st = await s.t.connectors.sync('google');
    expect(st.state).toBe('needs-reconnect');
    expect(st.error).toContain('Reconnect');
    expect(st.error).not.toContain(REFRESH.slice(4));
    // The last good events stay on the page.
    expect(s.t.calendar.list()).toHaveLength(1);
    const n = s.fake.calls.length;
    await s.t.connectors.sync('google');
    await s.t.connectors.sync('google');
    expect(s.fake.calls.length).toBe(n);
    // Creating an event is refused too, with no request.
    const r = await s.req('/api/calendar/events', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: 'X', start: '2030-01-01' }) });
    expect(r.status).toBe(409);
    expect(s.fake.calls.length).toBe(n);
    // Reconnecting brings it back.
    s.fake.listStatus = 200;
    s.fake.refreshValid = true;
    await connect(s);
    expect((await s.t.connectors.status('google')).state).toBe('connected');
  });

  it('a disabled Calendar API is an error that says how to fix it', async () => {
    const s = setup();
    s.fake.listStatus = 403;
    s.fake.listBody = { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } };
    await connect(s);
    expect(await s.t.connectors.status('google')).toMatchObject({ state: 'error', error: expect.stringContaining('Enable it') });
  });
});

describe('sync', () => {
  it('reads today through 14 days in the Mac\'s time zone, handles all-day events and skips cancelled ones', async () => {
    const s = setup();
    const today = startOfDay(new Date());
    s.fake.events = [
      { id: 'a', summary: 'Holiday', start: { date: dateOnly(addDays(today, 2)) }, end: { date: dateOnly(addDays(today, 3)) } },
      { id: 'b', summary: 'Call', htmlLink: 'https://www.google.com/calendar/event?eid=b', start: { dateTime: addDays(today, 1).toISOString() }, end: { dateTime: new Date(addDays(today, 1).getTime() + 1800_000).toISOString() }, extendedProperties: { private: { hubProject: 'demo', hubCreated: '1' } }, recurringEventId: 'series' },
      { id: 'c', status: 'cancelled', start: { date: dateOnly(today) }, end: { date: dateOnly(addDays(today, 1)) } },
      { id: 'd', start: { dateTime: addDays(today, 3).toISOString() }, end: { dateTime: addDays(today, 3).toISOString() }, htmlLink: 'javascript:alert(1)' },
    ];
    await connect(s);
    const list = s.fake.calls.find((c) => c.url.includes('/events?'))!;
    const q = new URL(list.url).searchParams;
    expect(q.get('timeZone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(q.get('singleEvents')).toBe('true');
    expect(new Date(q.get('timeMin')!).getTime()).toBe(today.getTime());
    expect(new Date(q.get('timeMax')!).getTime()).toBe(addDays(today, 15).getTime());
    expect(list.headers.Authorization).toBe(`Bearer ${ACCESS}`);

    const r = await (await s.req('/api/calendar', { headers: PAGE_GET })).json();
    expect(r.google).toMatchObject({ state: 'connected', account: 'someone@example.com' });
    expect(r.events.map((e: { id: string }) => e.id)).toEqual(['b', 'a', 'd']);
    expect(r.events[0]).toMatchObject({ title: 'Call', project: 'demo', recurring: true, createdByHub: true, allDay: false });
    expect(r.events[1]).toMatchObject({ title: 'Holiday', allDay: true, start: dateOnly(addDays(today, 2)) });
    expect(r.events[2]).toMatchObject({ title: '(No title)', htmlLink: null });
    const proj = await (await s.req('/api/calendar?project=demo', { headers: PAGE_GET })).json();
    expect(proj.events.map((e: { id: string }) => e.id)).toEqual(['b']);
  });
});

describe('createEvent', () => {
  it('sends one popup reminder, the project slug and a repeat rule, in the Mac\'s zone', async () => {
    const s = setup();
    await connect(s);
    const r = await s.req('/api/calendar/events', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: 'Planning', start: '2030-03-04T15:00', project: 'demo', repeat: 'RRULE:FREQ=WEEKLY;BYDAY=MO' }) });
    expect(r.status).toBe(200);
    const b = s.fake.lastInsert!;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(b).toMatchObject({
      summary: 'Planning',
      start: { timeZone: tz },
      end: { timeZone: tz },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      extendedProperties: { private: { hubCreated: '1', hubProject: 'demo' } },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    });
    const start = new Date((b.start as { dateTime: string }).dateTime);
    const end = new Date((b.end as { dateTime: string }).dateTime);
    expect(start.getHours()).toBe(15);
    expect(end.getTime() - start.getTime()).toBe(30 * 60_000);
    const { event } = await r.json();
    expect(event).toMatchObject({ id: 'new1', project: 'demo', recurring: true, createdByHub: true });
  });

  it('a date-only item is an all-day event with the all-day reminder, and defaults follow Settings', async () => {
    const s = setup();
    await connect(s);
    let r = await s.req('/api/settings/calendar', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ allDayReminderMinutes: 600, eventMinutes: 45 }) });
    expect(await r.json()).toEqual({ eventMinutes: 45, reminderMinutes: 15, allDayReminderMinutes: 600 });
    r = await s.req('/api/calendar/events', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: 'Rent', start: '2030-03-01' }) });
    expect(r.status).toBe(200);
    expect(s.fake.lastInsert).toMatchObject({ start: { date: '2030-03-01' }, end: { date: '2030-03-02' }, reminders: { overrides: [{ method: 'popup', minutes: 600 }] } });
    expect(s.fake.lastInsert!.extendedProperties).toEqual({ private: { hubCreated: '1' } });
  });

  it('refuses bad input before calling Google', async () => {
    const s = setup();
    await connect(s);
    const n = s.fake.calls.length;
    for (const body of [
      { title: '', start: '2030-01-01' },
      { title: 'x', start: 'next week' },
      { title: 'x', start: '2030-02-30' },
      { title: 'x', start: '2030-01-01T10:00', end: '2030-01-01T09:00' },
      { title: 'x', start: '2030-01-01', project: 'nope' },
      { title: 'x', start: '2030-01-01', repeat: 'FREQ=HOURLY' },
      { title: 'x', start: '2030-01-01', reminderMinutes: 50_000 },
      { title: 'x', start: '2030-01-01', extra: true },
    ]) {
      const r = await s.req('/api/calendar/events', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(body) });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(s.fake.calls.length).toBe(n);
  });

  it('needs Google connected, and refuses other origins', async () => {
    const s = setup();
    let r = await s.req('/api/calendar/events', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: 'x', start: '2030-01-01' }) });
    expect(r.status).toBe(409);
    await connect(s);
    for (const headers of [{ ...PAGE_WRITE, Origin: 'https://evil.example.com' }, { ...PAGE_GET, 'Content-Type': 'application/json' }]) {
      r = await s.req('/api/calendar/events', { method: 'POST', headers, body: JSON.stringify({ title: 'x', start: '2030-01-01' }) });
      expect(r.status).toBe(403);
      r = await s.req('/api/settings/calendar', { method: 'PUT', headers, body: JSON.stringify({ eventMinutes: 60 }) });
      expect(r.status).toBe(403);
    }
    expect(s.fake.lastInsert).toBeNull();
  });

  it('deletes only events the hub created', async () => {
    const s = setup();
    s.fake.events = [{ id: 'theirs', summary: 'Not ours', start: { date: dateOnly(new Date()) }, end: { date: dateOnly(addDays(new Date(), 1)) } }];
    await connect(s);
    let r = await s.req('/api/calendar/events/theirs', { method: 'DELETE', headers: { ...PAGE_GET, Origin: HUB } });
    expect(r.status).toBe(400);
    expect(s.fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await s.req('/api/calendar/events', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: 'Mine', start: dateOnly(new Date()) }) });
    r = await s.req('/api/calendar/events/new1', { method: 'DELETE', headers: { ...PAGE_GET, Origin: HUB } });
    expect(r.status).toBe(200);
    expect(s.fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(s.t.calendar.list().map((e) => e.id)).toEqual(['theirs']);
  });

  it('Disconnect forgets the refresh token and revokes it', async () => {
    const s = setup();
    await connect(s);
    await s.req('/api/connectors/google/disconnect', { method: 'POST', headers: PAGE_WRITE, body: '{}' });
    expect(s.t.secrets.dump()['google.refresh-token']).toBeUndefined();
    expect(s.fake.calls.at(-1)!.url).toBe('https://oauth2.googleapis.com/revoke');
  });
});

describe('event rules', () => {
  it('repeat rules: a checked subset', () => {
    expect(checkRepeat('rrule:freq=weekly;byday=mo,we')).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(checkRepeat('FREQ=MONTHLY;BYDAY=-1FR;COUNT=6')).toBe('FREQ=MONTHLY;BYDAY=-1FR;COUNT=6');
    for (const bad of ['BYDAY=MO', 'FREQ=WEEKLY;COUNT=2;UNTIL=20300101', 'FREQ=SECONDLY', 'FREQ=DAILY;X-FOO=1', 'FREQ=DAILY;FREQ=WEEKLY']) expect(() => checkRepeat(bad)).toThrow();
  });

  it('all-day end is inclusive in, exclusive out; offsets are accepted', () => {
    const d = normalizeEvent({ title: 'Trip', start: '2030-05-01', end: '2030-05-03' }, DEFAULTS);
    expect(d).toMatchObject({ allDay: true, start: '2030-05-01', end: '2030-05-04', reminderMinutes: 900 });
    const z = normalizeEvent({ title: 'Call', start: '2030-05-01T12:00:00Z' }, DEFAULTS);
    expect(new Date(z.start).getTime()).toBe(Date.parse('2030-05-01T12:00:00Z'));
    expect(new Date(z.end).getTime() - new Date(z.start).getTime()).toBe(30 * 60_000);
  });
});

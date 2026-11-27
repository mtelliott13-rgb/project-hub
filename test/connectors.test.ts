// Connector foundation (Today page, phase 1): the status flow, "needs
// reconnect", the Origin check on every write, and that secrets never reach the
// page, the database or error text. No test touches the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { anthropicConnector } from '../src/server/connectors/anthropic.ts';
import { connectorRegistry } from '../src/server/connectors/registry.ts';
import { AuthRejected, ConnectorError, type Connector } from '../src/server/connectors/types.ts';
import { openDb } from '../src/server/db/index.ts';
import { keychainSecrets, memorySecrets, scrub } from '../src/server/secrets.ts';
import { scanText } from '../scripts/check-secrets.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-conn-'));
  dirs.push(d);
  return d;
};

// Secret-shaped values are built from pieces so this file never holds one whole
// (pnpm check:secrets would rightly flag it).
const FAKE_KEY = 'sk-' + 'ant-' + 'test0000000000000000000000000000';
const FAKE_REFRESH = '1/' + '/0gFAKEFAKEFAKEFAKEFAKEFAKE';
const FAKE_CLIENT_SECRET = 'GOC' + 'SPX-fakefakefakefake';

const PAGE_WRITE = { ...PAGE_GET, Origin: HUB, 'Content-Type': 'application/json' };

/** A connector whose service is a script: `behaviour` decides what sync does. */
function fakeConnector(calls: string[], behaviour: { sync?: () => Promise<void> } = {}): Connector {
  return {
    id: 'fake',
    name: 'Fake service',
    description: 'For tests',
    sends: 'Nothing',
    fields: [
      { key: 'client-id', label: 'Client ID', secret: false },
      { key: 'client-secret', label: 'Client secret', secret: true },
    ],
    required: ['client-id', 'client-secret'],
    syncEveryMs: 60_000,
    syncOnStart: true,
    async connect(ctx) {
      calls.push('connect');
      await ctx.secrets.set('refresh-token', FAKE_REFRESH);
      return { kind: 'connected', account: 'someone@example.com' };
    },
    async disconnect(ctx) {
      calls.push('disconnect');
      await ctx.secrets.delete('refresh-token');
    },
    async sync() {
      calls.push('sync');
      await behaviour.sync?.();
    },
  };
}

function setup(connectors: Connector[], fetcher?: typeof fetch) {
  const dir = tmp();
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db, { connectors, fetch: fetcher });
  const app = createApp(t.deps);
  const req = (p: string, init: RequestInit = {}) => app.request(`${HUB}${p}`, init);
  return { dir, db, t, app, req };
}

describe('connector status flow', () => {
  it('goes not set up → connected → synced → not set up, and makes no calls until Connect', async () => {
    const calls: string[] = [];
    const { t, req } = setup([fakeConnector(calls)]);
    t.connectors.start();
    t.connectors.stop();

    let list = await (await req('/api/connectors', { headers: PAGE_GET })).json();
    expect(list[0]).toMatchObject({ id: 'fake', state: 'not-set-up', account: null, canConnect: false, canSync: false });
    // Nothing ran on start: it isn't connected.
    expect(calls).toEqual([]);

    // Connect before the fields are saved is refused.
    let r = await req('/api/connectors/fake/connect', { method: 'POST', headers: PAGE_WRITE, body: '{}' });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);

    r = await req('/api/connectors/fake/fields', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ 'client-id': 'abc.apps.example.com', 'client-secret': FAKE_CLIENT_SECRET }) });
    expect(r.status).toBe(200);
    const saved = await r.json();
    expect(saved.canConnect).toBe(true);
    expect(saved.fields).toEqual([
      expect.objectContaining({ key: 'client-id', saved: true, value: 'abc.apps.example.com' }),
      expect.objectContaining({ key: 'client-secret', saved: true, value: null }),
    ]);
    expect(t.secrets.dump()['fake.client-secret']).toBe(FAKE_CLIENT_SECRET);

    r = await req('/api/connectors/fake/connect', { method: 'POST', headers: PAGE_WRITE, body: '{}' });
    const connected = await r.json();
    expect(connected.status).toMatchObject({ state: 'connected', account: 'someone@example.com', canSync: true });
    expect(connected.status.lastSyncAt).toEqual(expect.any(String));
    expect(calls).toEqual(['connect', 'sync']);

    r = await req('/api/connectors/fake/sync', { method: 'POST', headers: PAGE_WRITE, body: '{}' });
    expect((await r.json()).status.state).toBe('connected');
    expect(calls).toEqual(['connect', 'sync', 'sync']);

    r = await req('/api/connectors/fake/disconnect', { method: 'POST', headers: PAGE_WRITE, body: '{}' });
    expect((await r.json()).status).toMatchObject({ state: 'not-set-up', account: null, lastSyncAt: null });
    expect(t.secrets.dump()['fake.refresh-token']).toBeUndefined();
    // The client secret stays saved until removed.
    expect(t.secrets.dump()['fake.client-secret']).toBe(FAKE_CLIENT_SECRET);

    // Sync while disconnected is refused and calls nothing.
    r = await req('/api/connectors/fake/sync', { method: 'POST', headers: PAGE_WRITE, body: '{}' });
    expect(r.status).toBe(409);
    expect(calls).toEqual(['connect', 'sync', 'sync', 'disconnect']);

    r = await req('/api/connectors/fake/fields/client-secret', { method: 'DELETE', headers: { ...PAGE_GET, Origin: HUB } });
    list = [await r.json()];
    expect(list[0].fields[1].saved).toBe(false);
    expect(t.secrets.dump()['fake.client-secret']).toBeUndefined();
  });

  it('an empty secret box leaves the saved value alone, and a bad field is refused', async () => {
    const { t, req } = setup([anthropicConnector]);
    await t.secrets.set('anthropic.api-key', FAKE_KEY);
    let r = await req('/api/connectors/anthropic/fields', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ 'api-key': '' }) });
    expect(r.status).toBe(200);
    expect(t.secrets.dump()['anthropic.api-key']).toBe(FAKE_KEY);
    r = await req('/api/connectors/anthropic/fields', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ 'api-key': 'not-a-key' }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).not.toContain('not-a-key');
    r = await req('/api/connectors/anthropic/fields', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ nope: 'x' }) });
    expect(r.status).toBe(400);
  });

  it('never puts a secret in an API answer or the database', async () => {
    const calls: string[] = [];
    const { dir, db, req } = setup([fakeConnector(calls)]);
    await req('/api/connectors/fake/fields', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ 'client-id': 'id-1', 'client-secret': FAKE_CLIENT_SECRET }) });
    const answers = [
      await (await req('/api/connectors/fake/connect', { method: 'POST', headers: PAGE_WRITE, body: '{}' })).text(),
      await (await req('/api/connectors', { headers: PAGE_GET })).text(),
    ].join('\n');
    expect(answers).not.toContain(FAKE_CLIENT_SECRET);
    expect(answers).not.toContain(FAKE_REFRESH);
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('');
    expect(bytes).not.toContain(FAKE_CLIENT_SECRET);
    expect(bytes).not.toContain(FAKE_REFRESH);
  });
});

describe('needs reconnect', () => {
  it('a rejected credential stops syncing until you reconnect; no retry loop', async () => {
    const calls: string[] = [];
    let reject = false;
    const c = fakeConnector(calls, {
      sync: async () => {
        if (reject) throw new AuthRejected('Google says this sign-in has expired. Reconnect.');
      },
    });
    const { t } = setup([c]);
    await t.connectors.saveFields('fake', { 'client-id': 'x', 'client-secret': FAKE_CLIENT_SECRET });
    await t.connectors.connect('fake');
    reject = true;
    const s = await t.connectors.sync('fake');
    expect(s).toMatchObject({ state: 'needs-reconnect', error: 'Google says this sign-in has expired. Reconnect.', canSync: false });
    const before = calls.length;
    // Scheduled or clicked syncs do nothing now.
    await t.connectors.sync('fake');
    await t.connectors.sync('fake');
    expect(calls.length).toBe(before);
    expect(t.connectors.isActive('fake')).toBe(false);
    // Reconnect works.
    reject = false;
    expect((await t.connectors.connect('fake')).status.state).toBe('connected');
  });

  it('other failures become "error", are tried again on schedule, and never leak their raw text', async () => {
    const calls: string[] = [];
    let fail: unknown = null;
    const c = fakeConnector(calls, {
      sync: async () => {
        if (fail) throw fail;
      },
    });
    const { t } = setup([c]);
    await t.connectors.saveFields('fake', { 'client-id': 'x', 'client-secret': FAKE_CLIENT_SECRET });
    await t.connectors.connect('fake');

    fail = new Error(`fetch failed: Authorization: Bearer ya29.${'a'.repeat(30)} ${FAKE_CLIENT_SECRET}`);
    let s = await t.connectors.sync('fake');
    expect(s.state).toBe('error');
    expect(s.error).toBe("Couldn't reach Fake service. It will try again at the next sync.");
    expect(t.connectors.isActive('fake')).toBe(true);

    // A connector's own message is shown, scrubbed of anything secret-shaped or saved.
    fail = new ConnectorError('http', `Bad request with ${FAKE_CLIENT_SECRET} and ${FAKE_REFRESH}`);
    s = await t.connectors.sync('fake');
    expect(s.error).toBe('Bad request with [hidden] and [hidden]');

    fail = null;
    s = await t.connectors.sync('fake');
    expect(s).toMatchObject({ state: 'connected', error: null });
  });

  it('concurrent syncs share one run', async () => {
    const calls: string[] = [];
    const { t } = setup([fakeConnector(calls, { sync: () => new Promise((r) => setTimeout(r, 20)) })]);
    await t.connectors.saveFields('fake', { 'client-id': 'x', 'client-secret': FAKE_CLIENT_SECRET });
    await t.connectors.connect('fake');
    calls.length = 0;
    await Promise.all([t.connectors.sync('fake'), t.connectors.sync('fake'), t.connectors.sync('fake')]);
    expect(calls).toEqual(['sync']);
  });
});

describe('Origin check on connector writes', () => {
  const writes: [string, string, string | undefined][] = [
    ['PUT', '/api/connectors/fake/fields', JSON.stringify({ 'client-id': 'x' })],
    ['DELETE', '/api/connectors/fake/fields/client-id', undefined],
    ['POST', '/api/connectors/fake/connect', '{}'],
    ['POST', '/api/connectors/fake/disconnect', '{}'],
    ['POST', '/api/connectors/fake/sync', '{}'],
  ];
  it.each(writes)('%s %s refuses other origins, no Origin, cross-site fetches and a missing token', async (method, p, body) => {
    const calls: string[] = [];
    const { req, t } = setup([fakeConnector(calls)]);
    const json: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};
    const bad: Record<string, string>[] = [
      { ...PAGE_GET, ...json, Origin: 'https://evil.example.com' },
      { ...PAGE_GET, ...json },
      { ...PAGE_GET, ...json, Origin: HUB, 'Sec-Fetch-Site': 'cross-site' },
      { ...json, Origin: HUB },
      { ...PAGE_GET, Origin: HUB, ...(body ? { 'Content-Type': 'text/plain' } : {}) },
    ];
    for (const headers of bad.slice(0, body ? 5 : 4)) {
      const r = await req(p, { method, headers, body });
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
    expect(calls).toEqual([]);
    expect(t.secrets.dump()).toEqual({});
    expect(await t.connectors.status('fake')).toMatchObject({ state: 'not-set-up' });
  });
});

describe('Anthropic connector', () => {
  it('checks the key once on Connect, with the key only in a header', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response('{"data":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    const { t } = setup([anthropicConnector], fetcher);
    await t.connectors.saveFields('anthropic', { 'api-key': FAKE_KEY });
    expect(seen).toEqual([]);
    const r = await t.connectors.connect('anthropic');
    expect(r.status).toMatchObject({ state: 'connected', account: 'API key' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(seen[0].headers['x-api-key']).toBe(FAKE_KEY);
  });

  it('a rejected key leaves it not set up, with a message that holds no key', async () => {
    const fetcher = (async () => new Response(`{"error":"invalid x-api-key ${FAKE_KEY}"}`, { status: 401 })) as unknown as typeof fetch;
    const { t } = setup([anthropicConnector], fetcher);
    await t.connectors.saveFields('anthropic', { 'api-key': FAKE_KEY });
    await expect(t.connectors.connect('anthropic')).rejects.toThrow('Anthropic rejected that API key');
    expect((await t.connectors.status('anthropic')).state).toBe('not-set-up');
  });
});

describe('secrets', () => {
  it('scrub hides secret shapes, token fields and known values', () => {
    const s = scrub(`token ya29.${'x'.repeat(20)} refresh ${FAKE_REFRESH} key ${FAKE_KEY} "refresh_token": "abc123" Bearer zzz my-own-value`, ['my-own-value']);
    expect(s).not.toMatch(/ya29\.x|0gFAKE|test0000|abc123|zzz|my-own-value/);
  });

  it('the Keychain store never puts a value on the command line', async () => {
    const dir = tmp();
    const log = path.join(dir, 'log');
    const bin = path.join(dir, 'security');
    // A stand-in for /usr/bin/security that records its arguments and stdin.
    fs.writeFileSync(bin, `#!/bin/sh\necho "ARGS: $*" >> "${log}"\ncat >> "${log}"\nexit 0\n`, { mode: 0o755 });
    const store = keychainSecrets('project-hub-test', bin);
    await store.set('anthropic.api-key', FAKE_KEY);
    const out = fs.readFileSync(log, 'utf8');
    expect(out).toContain('ARGS: -i');
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain(`-X ${Buffer.from(FAKE_KEY).toString('hex')}`);
    await expect(store.set('bad name; rm', 'x')).rejects.toThrow('Bad secret name');
  });

  it('the in-memory store refuses empty values and odd names', async () => {
    const m = memorySecrets();
    await expect(m.set('ok.name', '')).rejects.toThrow();
    await expect(m.get('../etc')).rejects.toThrow();
  });
});

describe('check:secrets', () => {
  const none = { everywhere: [], stagedOnly: [] };
  it('flags secret shapes and real-looking emails, not example ones', () => {
    const text = [`key = "${FAKE_KEY}"`, `secret ${FAKE_CLIENT_SECRET}`, `token ya29.${'b'.repeat(24)}`, `rt ${FAKE_REFRESH}`, 'mail someone@' + 'realmail.com', 'ok sample@example.com git@github.com'].join('\n');
    const found = scanText('x.ts', text, none, false);
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5]);
    // The report never prints a whole secret.
    expect(JSON.stringify(found)).not.toContain(FAKE_KEY);
  });

  it('flags your own details, and real project and event titles in staged lines only', () => {
    const personal = { everywhere: ['/Users/someone/'], stagedOnly: ['Secret Garden Plan'] };
    expect(scanText('a.md', 'path /Users/someone/code', personal, false)).toHaveLength(1);
    expect(scanText('a.md', 'the secret garden plan', personal, false)).toHaveLength(0);
    expect(scanText('a.md', 'the secret garden plan', personal, true, [7])).toEqual([{ file: 'a.md', line: 7, what: expect.stringContaining('real data') }]);
  });
});

describe('registry without the app', () => {
  it('start() syncs connected connectors on start and schedule only', async () => {
    const dir = tmp();
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const calls: string[] = [];
    const reg = connectorRegistry({ db, secrets: memorySecrets(), connectors: [fakeConnector(calls)], origin: HUB });
    reg.start();
    reg.stop();
    expect(calls).toEqual([]);
    await reg.saveFields('fake', { 'client-id': 'x', 'client-secret': FAKE_CLIENT_SECRET });
    await reg.connect('fake');
    calls.length = 0;
    reg.start();
    reg.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual(['sync']);
  });
});

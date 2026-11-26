// Holds every connector, keeps their status in the `connectors` table, and runs
// connect, disconnect and sync for them, including the scheduled syncs.
//
// A connector may make outside requests only while its state is "connected"
// or "error" (a failed sync, tried again on schedule). "not set up" and "needs
// reconnect" make none: only Connect (or Reconnect) on the page starts again.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { connectors as table, type ConnectorRow } from '../db/schema.ts';
import { scrub, type SecretStore } from '../secrets.ts';
import { getSetting, setSetting } from '../settings.ts';
import { AuthRejected, ConnectorError, type Connector, type ConnectorContext, type ConnectorState, type ConnectorStatus } from './types.ts';

export type RegistryDeps = {
  db: Db;
  secrets: SecretStore;
  connectors: Connector[];
  fetch?: typeof fetch;
  origin: string;
  /** Called after any status change, so open pages refetch. */
  onChange?: () => void;
  /** Called after a successful sync, e.g. to refresh what depends on the data. */
  onSynced?: (id: string) => void;
  log?: (line: string) => void;
  now?: () => Date;
  /** Sample data: connectors are local stand-ins (see ConnectorStatus.sample). */
  sample?: boolean;
};

const settingKey = (id: string, key: string) => `connector.${id}.${key}`;

/** Secrets scoped to one connector: "refresh-token" is stored as "<id>.refresh-token". */
function scoped(store: SecretStore, id: string): SecretStore {
  const k = (a: string) => `${id}.${a}`;
  return {
    get: (a) => store.get(k(a)),
    has: (a) => store.has(k(a)),
    set: (a, v) => store.set(k(a), v),
    delete: (a) => store.delete(k(a)),
  };
}

/** States in which a connector may talk to its service. */
export const ACTIVE_STATES: ConnectorState[] = ['connected', 'error'];

export function connectorRegistry(deps: RegistryDeps) {
  const { db, secrets, origin, onChange = () => {}, onSynced = () => {}, log = () => {}, now = () => new Date() } = deps;
  const byId = new Map(deps.connectors.map((c) => [c.id, c]));
  const syncing = new Map<string, Promise<ConnectorStatus>>();
  const timers: ReturnType<typeof setInterval>[] = [];

  const get = (id: string) => {
    const c = byId.get(id);
    if (!c) throw new ConnectorError('unknown', `No connector called "${id}"`);
    return c;
  };
  const row = (id: string): ConnectorRow | undefined => db.select().from(table).where(eq(table.id, id)).get();
  const write = (id: string, patch: Partial<Omit<ConnectorRow, 'id' | 'updatedAt'>>) => {
    const prev = row(id);
    const next = { state: prev?.state ?? 'not-set-up', account: prev?.account ?? null, lastSyncAt: prev?.lastSyncAt ?? null, lastError: prev?.lastError ?? null, ...patch, updatedAt: now() };
    db.insert(table).values({ id, ...next }).onConflictDoUpdate({ target: table.id, set: next }).run();
    onChange();
  };
  const ctx = (c: Connector): ConnectorContext => ({
    secrets: scoped(secrets, c.id),
    getSetting: (k) => getSetting(db, settingKey(c.id, k)),
    setSetting: (k, v) => setSetting(db, settingKey(c.id, k), v),
    fetch: deps.fetch ?? fetch,
    now,
    origin,
  });

  /** A message that is safe to store and show, whatever was thrown. */
  async function safeMessage(c: Connector, e: unknown): Promise<{ code: string; message: string }> {
    const known: string[] = [];
    for (const f of c.fields.filter((f) => f.secret)) known.push((await ctx(c).secrets.get(f.key).catch(() => null)) ?? '');
    if (e instanceof ConnectorError) return { code: e.code, message: scrub(e.message, known) };
    // Anything else (a network failure, a bug) may carry request details: never pass it on.
    return { code: 'failed', message: `Couldn't reach ${c.name}. It will try again at the next sync.` };
  }

  async function status(id: string): Promise<ConnectorStatus> {
    const c = get(id);
    const r = row(id);
    const fields = await Promise.all(
      c.fields.map(async ({ check: _check, ...f }) => {
        if (f.secret) return { ...f, saved: await ctx(c).secrets.has(f.key), value: null };
        const v = ctx(c).getSetting(f.key);
        return { ...f, saved: typeof v === 'string' && v !== '', value: typeof v === 'string' ? v : null };
      }),
    );
    const state = r?.state ?? 'not-set-up';
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      sends: c.sends,
      state,
      account: state === 'not-set-up' ? null : (r?.account ?? null),
      lastSyncAt: r?.lastSyncAt ? r.lastSyncAt.toISOString() : null,
      error: r?.lastError ?? null,
      fields,
      canConnect: c.required.every((k) => fields.find((f) => f.key === k)?.saved),
      canSync: !!c.sync && ACTIVE_STATES.includes(state),
      acceptsFile: !!c.importFile,
      ...(deps.sample && { sample: true }),
    };
  }

  async function saveFields(id: string, values: Record<string, unknown>) {
    const c = get(id);
    for (const [key, raw] of Object.entries(values)) {
      const f = c.fields.find((f) => f.key === key);
      if (!f) throw new ConnectorError('bad-field', `${c.name} has no field "${key}"`);
      if (typeof raw !== 'string') throw new ConnectorError('bad-field', `${f.label} must be text`);
      const value = raw.trim();
      // An empty secret box means "leave the saved one alone".
      if (f.secret && value === '') continue;
      const problem = value === '' ? null : (f.check?.(value) ?? null);
      if (problem) throw new ConnectorError('bad-field', problem);
      if (f.secret) await ctx(c).secrets.set(f.key, value);
      else ctx(c).setSetting(f.key, value || null);
    }
    onChange();
    return status(id);
  }

  async function removeField(id: string, key: string) {
    const c = get(id);
    const f = c.fields.find((f) => f.key === key);
    if (!f) throw new ConnectorError('bad-field', `${c.name} has no field "${key}"`);
    if (f.secret) await ctx(c).secrets.delete(f.key);
    else ctx(c).setSetting(f.key, null);
    onChange();
    return status(id);
  }

  async function connect(id: string, opts: { returnTo?: string } = {}): Promise<{ status: ConnectorStatus; redirect?: string }> {
    const c = get(id);
    if (deps.sample) throw new ConnectorError('sample', 'This is the sample data: connectors stay off and make no outside requests.');
    const s = await status(id);
    if (!s.canConnect) throw new ConnectorError('not-ready', `Save ${c.required.map((k) => c.fields.find((f) => f.key === k)?.label ?? k).join(' and ')} first`);
    try {
      const r = await c.connect(ctx(c), opts);
      if (r.kind === 'redirect') return { status: s, redirect: r.url };
      await markConnected(id, r.account);
      return { status: await status(id) };
    } catch (e) {
      const { message } = await safeMessage(c, e);
      log(`Connector ${id}: connect failed: ${message}`);
      throw new ConnectorError('connect-failed', message);
    }
  }

  /**
   * The service sent you back (OAuth). Returns where to send the browser next,
   * and a short secret-free message if it failed (also kept as the connector's error).
   */
  async function finishCallback(id: string, params: URLSearchParams): Promise<{ returnTo: string; error: string | null }> {
    const c = get(id);
    if (!c.callback || deps.sample) return { returnTo: '/settings#connections', error: 'Not expected' };
    try {
      const r = await c.callback(ctx(c), params);
      await markConnected(id, r.account);
      return { returnTo: r.returnTo, error: null };
    } catch (e) {
      const { message } = await safeMessage(c, e);
      const returnTo = (e as { returnTo?: unknown }).returnTo;
      // Keep the current state (a failed reconnect still needs reconnecting), with the reason.
      write(id, { lastError: message });
      log(`Connector ${id}: sign-in failed: ${message}`);
      return { returnTo: typeof returnTo === 'string' ? returnTo : '/settings#connections', error: message };
    }
  }

  async function importFile(id: string, json: unknown) {
    const c = get(id);
    if (!c.importFile) throw new ConnectorError('bad-field', `${c.name} doesn't take a file`);
    return saveFields(id, c.importFile(json));
  }

  /** Records a finished connect (also from an OAuth callback), then syncs once. */
  async function markConnected(id: string, account: string | null) {
    const c = get(id);
    write(id, { state: 'connected', account, lastError: null });
    log(`Connector ${id}: connected`);
    if (c.sync) await sync(id);
  }

  async function disconnect(id: string) {
    const c = get(id);
    try {
      await c.disconnect(ctx(c));
    } catch (e) {
      // Still forget it locally: Disconnect must always work.
      log(`Connector ${id}: disconnect cleanup failed: ${(await safeMessage(c, e)).message}`);
    }
    write(id, { state: 'not-set-up', account: null, lastSyncAt: null, lastError: null });
    log(`Connector ${id}: disconnected`);
    return status(id);
  }

  /** Runs one sync, unless one is already running (then waits for it). Never retries. */
  function sync(id: string): Promise<ConnectorStatus> {
    const c = get(id);
    const running = syncing.get(id);
    if (running) return running;
    const p = (async () => {
      const state = row(id)?.state ?? 'not-set-up';
      if (!c.sync || !ACTIVE_STATES.includes(state)) return status(id);
      try {
        const r = await c.sync(ctx(c));
        write(id, { state: 'connected', lastSyncAt: now(), lastError: null, ...(r && r.account !== undefined && { account: r.account }) });
        onSynced(id);
      } catch (e) {
        const { message } = await safeMessage(c, e);
        if (e instanceof AuthRejected) {
          write(id, { state: 'needs-reconnect', lastError: message });
          log(`Connector ${id}: needs reconnect`);
        } else {
          write(id, { state: 'error', lastError: message });
          log(`Connector ${id}: sync failed: ${message}`);
        }
      }
      return status(id);
    })().finally(() => syncing.delete(id));
    syncing.set(id, p);
    return p;
  }

  /** Marks a connector as needing reconnect from outside a sync (e.g. creating an event hit a rejected token). */
  async function markNeedsReconnect(id: string, e: AuthRejected) {
    const c = get(id);
    write(id, { state: 'needs-reconnect', lastError: (await safeMessage(c, e)).message });
  }

  return {
    ids: () => [...byId.keys()],
    connector: get,
    context: (id: string) => ctx(get(id)),
    status,
    statuses: () => Promise.all([...byId.keys()].map(status)),
    state: (id: string): ConnectorState => row(id)?.state ?? 'not-set-up',
    isActive: (id: string) => ACTIVE_STATES.includes(row(id)?.state ?? 'not-set-up'),
    saveFields,
    removeField,
    connect,
    finishCallback,
    importFile,
    markConnected,
    markNeedsReconnect,
    disconnect,
    sync,
    safeMessage: (id: string, e: unknown) => safeMessage(get(id), e),
    /** Syncs connected connectors now (those that ask for it) and on their schedules. */
    start() {
      for (const c of byId.values()) {
        if (!c.sync || !c.syncEveryMs) continue;
        if (c.syncOnStart) void sync(c.id);
        const t = setInterval(() => void sync(c.id), c.syncEveryMs);
        t.unref?.();
        timers.push(t);
      }
    },
    stop() {
      timers.splice(0).forEach(clearInterval);
    },
  };
}

export type ConnectorRegistry = ReturnType<typeof connectorRegistry>;

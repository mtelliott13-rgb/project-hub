// The connector interface (Today page). A connector is one outside service the
// hub can talk to: Google (Calendar now, Gmail later), the Anthropic API, and
// later Fidelity through SnapTrade or a news source.
//
// Rules every connector follows:
// - Off until you click Connect. Before that (and after Disconnect, or once it
//   needs reconnecting) the hub makes no requests to the service for it.
// - Secrets go only through ctx.secrets (the Keychain). The page sees status:
//   state, account, last sync, a secret-free error, and which fields are saved.
// - Failures throw ConnectorError. AuthRejected means the saved credential no
//   longer works: the connector becomes "needs reconnect" and stops syncing
//   until you reconnect. Nothing retries in a loop.
import type { SecretStore } from '../secrets.ts';

export type ConnectorState = 'not-set-up' | 'connected' | 'needs-reconnect' | 'error';

/** A value you type on Settings → Connections. Secret ones go to the Keychain and are never shown again. */
export type FieldSpec = {
  key: string;
  label: string;
  secret: boolean;
  help?: string;
  placeholder?: string;
  /** Checked before saving; return a reason to refuse. Never echo the value in it. */
  check?: (value: string) => string | null;
};

/** A field as the page sees it: secret values never leave the server. */
export type FieldStatus = Omit<FieldSpec, 'check'> & { saved: boolean; value: string | null };

export type ConnectorStatus = {
  id: string;
  name: string;
  description: string;
  /** Plain words: what goes out, to where, and when. Shown on Settings. */
  sends: string;
  state: ConnectorState;
  account: string | null;
  lastSyncAt: string | null;
  error: string | null;
  fields: FieldStatus[];
  /** Whether Connect can be clicked now (its required fields are saved). */
  canConnect: boolean;
  canSync: boolean;
  /** Set when the hub runs on sample data: the connector is a local stand-in and makes no requests. */
  sample?: boolean;
};

export type ConnectorContext = {
  /** Secrets for this connector only; names are prefixed with its id. */
  secrets: SecretStore;
  /** Its non-secret fields and private settings. */
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  fetch: typeof fetch;
  now(): Date;
  /** The hub's origin, for OAuth redirects (http://127.0.0.1:4747). */
  origin: string;
};

/** What connect() did: finished, or the page should send you to `url` (OAuth). */
export type ConnectResult = { kind: 'connected'; account: string | null } | { kind: 'redirect'; url: string };

export interface Connector {
  id: string;
  name: string;
  description: string;
  sends: string;
  fields: FieldSpec[];
  /** Fields that must be saved before Connect. */
  required: string[];
  /** How often to sync while connected; omit for connectors that don't sync. */
  syncEveryMs?: number;
  /** Also sync once when the hub starts (if connected). */
  syncOnStart?: boolean;
  connect(ctx: ConnectorContext): Promise<ConnectResult>;
  /** Forgets what connecting obtained (tokens). Saved fields stay until you remove them. */
  disconnect(ctx: ConnectorContext): Promise<void>;
  /** Fetches fresh data. May return an updated account name. */
  sync?(ctx: ConnectorContext): Promise<{ account?: string | null } | void>;
}

/** A failure that is safe to show: `message` must hold no secret (it is scrubbed again anyway). */
export class ConnectorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The service rejected the saved credential (e.g. Google's invalid_grant). */
export class AuthRejected extends ConnectorError {
  constructor(message = 'The service no longer accepts the saved sign-in. Reconnect to continue.') {
    super('auth-rejected', message);
  }
}

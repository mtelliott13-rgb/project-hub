// Secrets for connectors: OAuth refresh tokens, the Google client secret and
// the Anthropic API key. On this Mac they live in the login Keychain under the
// service "project-hub", one item per account name (e.g. "google.refresh-token").
// Never in SQLite, ~/.project-hub files, logs, error messages or API answers.
//
// Values never go on a command line, where `ps` would show them. Writes run
// `security -i` (interactive mode) and send the add command, with the value
// hex-encoded (-X), on its stdin, so the process list shows only `security -i`.
// Reads print the value on stdout (`find-generic-password -w`).
//
// CI runs on Linux, so everything goes through SecretStore; tests use
// memorySecrets().
import { execa } from 'execa';

export const KEYCHAIN_SERVICE = 'project-hub';

export interface SecretStore {
  get(account: string): Promise<string | null>;
  /** Whether a value is saved, without reading it. */
  has(account: string): Promise<boolean>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/** Account names are fixed identifiers like "google.client-secret": nothing that needs quoting. */
const ACCOUNT = /^[a-z0-9][a-z0-9.-]{0,63}$/;
function checkAccount(account: string) {
  if (!ACCOUNT.test(account)) throw new Error(`Bad secret name: ${account}`);
}

/** Item not found (errSecItemNotFound). */
const NOT_FOUND = 44;

export function keychainSecrets(service = KEYCHAIN_SERVICE, bin = '/usr/bin/security'): SecretStore {
  // A minimal environment, and output never logged: it can hold the value.
  const run = (args: string[], input?: string) =>
    execa(bin, args, { input, reject: false, timeout: 10_000, env: { PATH: '/usr/bin:/bin' }, extendEnv: false });
  return {
    async get(account) {
      checkAccount(account);
      const r = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (r.exitCode === NOT_FOUND) return null;
      if (r.exitCode !== 0) throw new Error(`Couldn't read "${account}" from the Keychain (security exited ${r.exitCode})`);
      return String(r.stdout).replace(/\n$/, '');
    },
    async has(account) {
      checkAccount(account);
      const r = await run(['find-generic-password', '-s', service, '-a', account]);
      return r.exitCode === 0;
    },
    async set(account, value) {
      checkAccount(account);
      if (!value) throw new Error('Refusing to save an empty secret');
      const hex = Buffer.from(value, 'utf8').toString('hex');
      const r = await run(['-i'], `add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`);
      if (r.exitCode !== 0) throw new Error(`Couldn't save "${account}" to the Keychain (security exited ${r.exitCode})`);
    },
    async delete(account) {
      checkAccount(account);
      const r = await run(['delete-generic-password', '-s', service, '-a', account]);
      if (r.exitCode !== 0 && r.exitCode !== NOT_FOUND) throw new Error(`Couldn't delete "${account}" from the Keychain (security exited ${r.exitCode})`);
    },
  };
}

/** For tests and non-Mac runs: an in-memory store with the same rules. */
export function memorySecrets(initial: Record<string, string> = {}): SecretStore & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(initial));
  return {
    async get(a) {
      checkAccount(a);
      return m.get(a) ?? null;
    },
    async has(a) {
      checkAccount(a);
      return m.has(a);
    },
    async set(a, v) {
      checkAccount(a);
      if (!v) throw new Error('Refusing to save an empty secret');
      m.set(a, v);
    },
    async delete(a) {
      checkAccount(a);
      m.delete(a);
    },
    dump: () => Object.fromEntries(m),
  };
}

// Shapes of the secrets the hub handles, for scrubbing text before it is
// stored, logged or sent to the page. scripts/check-secrets.ts uses the same list.
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Google client secret', re: /GOCSPX-[A-Za-z0-9_-]{8,}/g },
  { name: 'Google access token', re: /ya29\.[A-Za-z0-9_.-]{10,}/g },
  { name: 'Google refresh token', re: /1\/\/[A-Za-z0-9_-]{10,}/g },
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'Private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * Removes anything secret-shaped, and any of `known` (values the caller holds),
 * from text that might be logged, stored or shown. Used on every connector error.
 */
export function scrub(text: string, known: (string | null | undefined)[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 6) out = out.split(k).join('[hidden]');
  for (const { re } of SECRET_PATTERNS) out = out.replace(re, '[hidden]');
  // Bearer headers and token fields that may be echoed back in an error body.
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[hidden]');
  out = out.replace(/("?(?:access_token|refresh_token|client_secret|id_token|code_verifier|code|x-api-key)"?\s*[:=]\s*"?)[^\s"&,}]+/gi, '$1[hidden]');
  return out;
}

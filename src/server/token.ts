import crypto from 'node:crypto';
import fs from 'node:fs';

/** Reads the shared hook token, creating it (owner-only) on first run. */
export function ensureToken(file: string): string {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

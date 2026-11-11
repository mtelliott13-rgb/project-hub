// Review queue rules shared by the server and the page (no Node imports):
// the allowed values, the card's summary line and the display order.
export const APP_STATUSES = ['draft', 'reviewed', 'submitted'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
export const FITS = ['strong', 'possible', 'stretch', 'skip'] as const;

/** "2 drafts · 1 reviewed · 3 submitted" (drafts first, as on the card). */
export function queueSummary(counts: Record<AppStatus, number>): string {
  return `${counts.draft} draft${counts.draft === 1 ? '' : 's'} · ${counts.reviewed} reviewed · ${counts.submitted} submitted`;
}

/** Drafts, then reviewed, then submitted (unknown statuses last); soonest deadline first, no deadline after, then newest. */
export function sortApplications<T extends { status: string; deadline: string | null; added: string | null }>(items: T[]): T[] {
  const rank = (s: string) => {
    const i = (APP_STATUSES as readonly string[]).indexOf(s);
    return i === -1 ? APP_STATUSES.length : i;
  };
  return [...items].sort(
    (a, b) => rank(a.status) - rank(b.status) || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || (b.added ?? '').localeCompare(a.added ?? ''),
  );
}

/** How many fields are over their limit, and how many shorter drafts wait for approval. */
export type LimitFlags = { over: number; drafts: number };
export function limitFlags(parts: readonly { type: string; count?: { over: boolean }; draft?: unknown }[]): LimitFlags {
  let over = 0;
  let drafts = 0;
  for (const p of parts) {
    if (p.type !== 'field') continue;
    if (p.count?.over) over++;
    if (p.draft) drafts++;
  }
  return { over, drafts };
}

/** "2 fields over their limit · 1 shorter draft pending your approval", or null when there's nothing. */
export function limitSummary({ over, drafts }: LimitFlags): string | null {
  const bits = [over && `${over} field${over === 1 ? '' : 's'} over ${over === 1 ? 'its' : 'their'} limit`, drafts && `${drafts} shorter draft${drafts === 1 ? '' : 's'} pending your approval`].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

/**
 * Lowercase hex SHA-256 of a string's UTF-8 bytes, as Career HQ's approve-draft
 * expects. The page hashes the draft exactly as it received and showed it.
 * Uses Web Crypto, which both the page (127.0.0.1 is a secure context) and Node have.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// "Add a job": Career HQ's `review_queue.py launch-manual [--url <link>]`, posting
// text on stdin (SPEC.md "Manual job input"). These mirror Career HQ's own
// checks (manual_posting.py check_url / check_text) so the page can say what's
// wrong before anything runs; Career HQ checks again itself.
export const MANUAL_MAX_URL = 2048;
export const MANUAL_MAX_TEXT_BYTES = 200_000;

/** Why a link isn't one Career HQ accepts (https only, a host, no user name, no spaces or control characters), or null. */
export function httpsLinkProblem(url: string): string | null {
  if (!url) return 'No link given';
  if ([...url].length > MANUAL_MAX_URL) return `The link is longer than ${MANUAL_MAX_URL} characters`;
  // Python's isspace() also counts U+0085 and U+001C–U+001F; those are covered here too.
  if (/[\s\x00-\x1f\x7f\x85]/u.test(url)) return 'The link has spaces or control characters in it';
  if (!/^https:\/\//i.test(url)) return 'Only https:// links are accepted';
  // The host part: at least one character, no user name or password (no @), not just a port.
  const m = /^https:\/\/([^/?#]*)/i.exec(url);
  if (!m || !m[1] || m[1].includes('@') || m[1].startsWith(':')) return 'The link has no host (or has a user name in it)';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return 'The link has no host (or has a user name in it)';
  } catch {
    return "The link doesn't parse";
  }
  return null;
}

/** UTF-8 size of the text, as Career HQ counts it. */
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Why pasted posting text isn't acceptable (blank, NUL, broken Unicode, over 200,000 bytes), or null. */
export function postingTextProblem(text: string): string | null {
  if (!text.trim()) return 'The posting text is empty';
  if (text.includes('\0')) return 'The posting text has NUL characters in it';
  if (/\p{Cs}/u.test(text)) return "The posting text isn't valid Unicode";
  const bytes = utf8Bytes(text);
  if (bytes > MANUAL_MAX_TEXT_BYTES) return `The posting text is ${bytes.toLocaleString('en-US')} bytes; the limit is ${MANUAL_MAX_TEXT_BYTES.toLocaleString('en-US')}`;
  return null;
}

export type ManualJob = { mode: 'empty' | 'link' | 'text'; url?: string; text?: string; problem: string | null };

/**
 * What the "Add a job" box holds. One word with no spaces is a link (a posting
 * is never one word), so a bad link is refused rather than sent as text.
 * Anything else is posting text, sent as written, plus the optional "Posting
 * link" (for the duplicate check) when it's filled in.
 */
export function manualJobInput(box: string, link = ''): ManualJob {
  const trimmed = box.trim();
  if (!trimmed) return { mode: 'empty', problem: null };
  if (!/\s/u.test(trimmed)) return { mode: 'link', url: trimmed, problem: httpsLinkProblem(trimmed) };
  const url = link.trim() || undefined;
  return { mode: 'text', text: box, url, problem: postingTextProblem(box) ?? (url ? httpsLinkProblem(url) : null) };
}

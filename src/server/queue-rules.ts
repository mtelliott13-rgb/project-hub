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

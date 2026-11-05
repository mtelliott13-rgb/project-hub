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

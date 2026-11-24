// Project colours and other pure display rules shared by the cards, the project
// page and the charts. No React here, so tests can import it.

/** The eight project slots: base colour and a deep shade for text on a tint of it. */
export const PROJECT_PALETTE = [
  { base: '#3E63DD', deep: '#2847B8' },
  { base: '#2AA79B', deep: '#136F66' },
  { base: '#E5663A', deep: '#B4441B' },
  { base: '#E0A21B', deep: '#8A5E00' },
  { base: '#D45AAE', deep: '#A3307F' },
  { base: '#7B61E8', deep: '#5236C9' },
  { base: '#3A9BDC', deep: '#1D6DA6' },
  { base: '#5FA531', deep: '#3F7A1C' },
] as const;

export type ProjectColor = (typeof PROJECT_PALETTE)[number];

const slotOf = (slug: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % PROJECT_PALETTE.length;
};

const assigned = new Map<string, number>();

/**
 * Gives every project its slot: the slot its slug hashes to, or the next free
 * one if an older project (by when it was added) already has it. A new project
 * never recolours an existing one, and reordering or renaming changes nothing.
 * Only removing a project can free a slot that a later, colliding one moves
 * back to. Beyond eight projects, colours repeat.
 */
export function assignProjectColors(projects: { slug: string; createdAt: string }[]): void {
  assigned.clear();
  const used = new Set<number>();
  const byAge = [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug));
  for (const p of byAge) {
    let slot = slotOf(p.slug);
    if (used.size < PROJECT_PALETTE.length) while (used.has(slot)) slot = (slot + 1) % PROJECT_PALETTE.length;
    used.add(slot);
    assigned.set(p.slug, slot);
  }
}

/** A project's colour (see assignProjectColors); the slug's own slot until the list has loaded. */
export function projectColor(slug: string): ProjectColor {
  return PROJECT_PALETTE[assigned.get(slug) ?? slotOf(slug)];
}

/** Up to two initials for a project chip: "Career HQ" → "CH", "hub" → "HU". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** A hex colour at an opacity, as rgba(). */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Chart colours, in their colorblind-checked order. */
export const CHART = {
  sessions: '#3E63DD',
  chats: '#E5663A',
  commits: '#2AA79B',
  files: '#E0A21B',
  claude: '#3E63DD',
  code: '#2AA79B',
} as const;

// Idle sessions (v4, Phase 4): Claude Code sometimes never reports that a session
// ended, so it shows as running for days. The page calls a running session whose
// last activity is over 24 hours old "idle". The server's state is unchanged.
export const IDLE_MS = 24 * 3_600_000;

type Live = { state: string; lastActiveAt: string };

export const isIdle = (s: Live, now = Date.now()) => s.state === 'running' && now - Date.parse(s.lastActiveAt) > IDLE_MS;

/** Whole days since a session was last active (at least 1 for an idle one). */
export const idleDays = (s: Live, now = Date.now()) => Math.max(1, Math.floor((now - Date.parse(s.lastActiveAt)) / 86_400_000));

/** "Running", "Running · idle 3d" or "Ended". */
export const sessionTag = (s: Live, now = Date.now()) => (s.state !== 'running' ? 'Ended' : isIdle(s, now) ? `Running · idle ${idleDays(s, now)}d` : 'Running');

/** Running and idle counts over some sessions. */
export function runningCounts(sessions: Live[], now = Date.now()) {
  const running = sessions.filter((s) => s.state === 'running');
  return { running: running.length, idle: running.filter((s) => isIdle(s, now)).length };
}

/** "3 running", or "3 running (2 idle)" when some are idle. */
export const runningLabel = ({ running, idle }: { running: number; idle: number }) => `${running} running${idle ? ` (${idle} idle)` : ''}`;

/** Time-of-day bucket for the welcome banner. */
export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** A stable angle (0–360) for a slug, so a project keeps its place on the constellation. */
export function slugAngle(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 3600) / 10;
}

/** Where the first project of each single-project ring goes (degrees; 0 = right, 90 = down): upper right. */
const SINGLES_START = -60;

/**
 * Constellation angles (degrees, 0 = right, 90 = down) for rings of slugs,
 * inner to outer; the output lines up with the input. Each ring's projects
 * are evenly spaced in slugAngle order, so a project keeps its place while its
 * ring's members stay the same. A ring of two or more balances itself, and is
 * turned a third of its spacing per tier so rings don't line their dots up.
 * Rings with one project are spread evenly among themselves (two sit opposite
 * each other), so the map doesn't tip to one side.
 */
export function ringAngles(rings: string[][]): number[][] {
  const singles = rings.flatMap((r, t) => (r.length === 1 ? [t] : []));
  const norm = (a: number) => ((a % 360) + 360) % 360;
  return rings.map((ring, t) => {
    if (ring.length === 0) return [];
    if (ring.length === 1) return [norm(SINGLES_START + (singles.indexOf(t) * 360) / singles.length)];
    const step = 360 / ring.length;
    const order = ring.map((slug, i) => ({ a: slugAngle(slug), slug, i })).sort((x, y) => x.a - y.a || x.slug.localeCompare(y.slug));
    const out = new Array<number>(ring.length);
    order.forEach(({ i }, k) => (out[i] = norm((t * step) / 3 + k * step)));
    return out;
  });
}

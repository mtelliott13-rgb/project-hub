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

/**
 * A project's colour, from a stable hash of its slug (FNV-1a), so a project
 * keeps its colour however the list changes: adding, removing or reordering
 * projects never recolours another one.
 */
export function projectColor(slug: string): ProjectColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PROJECT_PALETTE[(h >>> 0) % PROJECT_PALETTE.length];
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

/**
 * Spreads angles on a ring so labels don't collide: each keeps its own angle
 * unless it's closer than `gap` degrees to the previous one, in which case it's
 * pushed along. Input order doesn't matter; output lines up with input.
 */
export function spreadAngles(angles: number[], gap: number): number[] {
  if (angles.length < 2) return [...angles];
  const order = angles.map((a, i) => ({ a: ((a % 360) + 360) % 360, i })).sort((x, y) => x.a - y.a);
  const n = order.length;
  const step = Math.min(gap, 360 / n);
  // Start after the largest gap, so pushing never wraps into the first one.
  let start = 0;
  let widest = -1;
  for (let k = 0; k < n; k++) {
    const next = k === n - 1 ? order[0].a + 360 : order[k + 1].a;
    if (next - order[k].a > widest) {
      widest = next - order[k].a;
      start = (k + 1) % n;
    }
  }
  const out = new Array<number>(n);
  let prev = -Infinity;
  for (let j = 0; j < n; j++) {
    const { a, i } = order[(start + j) % n];
    let v = a + (j > 0 && (start + j) % n < start ? 360 : 0);
    if (v < prev + step) v = prev + step;
    out[i] = v % 360;
    prev = v;
  }
  return out;
}

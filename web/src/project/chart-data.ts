// Data for the project page's charts: the last N days of the timeline binned by
// day, and a monotone curve through points (so an area chart never dips below
// zero or overshoots between days). Pure, so tests can import it.
import type { ActivityEvent } from '../../../src/server/activity.ts';

export type DayBin = {
  /** Local midnight, ms. */
  start: number;
  label: string;
  today: boolean;
  sessions: number;
  chats: number;
  commits: number;
  /** Hour groups of saved files (the timeline groups saves by clock hour). */
  files: number;
  claude: number;
  code: number;
};

const midnight = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** The last `days` days (today last), counting sessions, chats, commits and file-save groups. */
export function binDays(events: ActivityEvent[], days = 10, now = Date.now()): DayBin[] {
  const today = midnight(now);
  const bins: DayBin[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Step back by calendar days (not 24 h), so daylight-saving changes don't shift bins.
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const start = d.getTime();
    bins.push({ start, label: d.toLocaleDateString(undefined, { weekday: 'short' }), today: i === 0, sessions: 0, chats: 0, commits: 0, files: 0, claude: 0, code: 0 });
  }
  const index = new Map(bins.map((b, i) => [b.start, i]));
  for (const e of events) {
    const i = index.get(midnight(Date.parse(e.at)));
    if (i === undefined) continue;
    const b = bins[i];
    if (e.kind === 'session') b.sessions++;
    else if (e.kind === 'chat') b.chats++;
    else if (e.kind === 'commit') b.commits++;
    else if (e.kind === 'files') b.files++;
  }
  for (const b of bins) {
    b.claude = b.sessions + b.chats;
    b.code = b.commits + b.files;
  }
  return bins;
}

/** A tidy axis top and step: 0/2/4/6 for small counts, 0/5/10/15… or 0/10/20… for bigger ones. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 2 };
  const steps = [2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find((s) => max / s <= 4) ?? Math.ceil(max / 4);
  return { top: Math.max(step * 2, Math.ceil(max / step) * step), step };
}

/**
 * An SVG path through the points using monotone cubic interpolation
 * (Fritsch–Carlson), the same idea as d3's curveMonotoneX: between two points
 * the curve stays within their y range, so it never goes below a zero baseline.
 */
export function monotonePath(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0][0]},${points[0][1]}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  const f = (v: number) => Math.round(v * 100) / 100;
  let d = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += ` C${f(x0 + h)},${f(y0 + m[i] * h)} ${f(x1 - h)},${f(y1 - m[i + 1] * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

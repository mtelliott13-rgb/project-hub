// What the Today page derives from events, tasks and sessions. Pure (dates are
// passed in), so it's tested in test/today-ui.test.ts. Times are shown in the
// browser's zone, which on this Mac is the same zone the server syncs in.
import type { EventDto, TaskDto } from '../api.ts';

export type DayGroup = { date: Date; key: string; label: string; events: EventDto[] };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whether an event belongs on the day starting at `day`: all-day ones on every day they cover, timed ones on their start day (and today, if still going). */
export function onDay(e: EventDto, day: Date, now: Date): boolean {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  const s = Date.parse(e.startsAt);
  const end = Date.parse(e.endsAt);
  if (e.allDay) return s < to && end > from;
  if (s >= from && s < to) return true;
  // Started before today and still going (e.g. an overnight event).
  return key(day) === key(now) && s < from && end > now.getTime();
}

/** Sorts a day's events: all-day first, then by start time, then title. */
export function sortDay(events: EventDto[]): EventDto[] {
  return [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.title.localeCompare(b.title));
}

/** "Today", "Tomorrow", else "Fri, Nov 28". */
export function dayLabel(day: Date, now: Date): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Today's events, and the next `days` days as groups (empty days included, so the week reads in order). */
export function agenda(events: EventDto[], now: Date, days = 7): { today: EventDto[]; next: DayGroup[] } {
  const today = startOfDay(now);
  const next: DayGroup[] = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, i);
    next.push({ date: d, key: key(d), label: dayLabel(d, now), events: sortDay(events.filter((e) => onDay(e, d, now))) });
  }
  return { today: sortDay(events.filter((e) => onDay(e, today, now))), next };
}

/** "3:00 PM". */
export const clock = (iso: string | Date) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "3:00 – 3:30 PM" style range, or "All day". */
export function timeRange(e: EventDto): string {
  if (e.allDay) return 'All day';
  return `${clock(e.startsAt)} – ${clock(e.endsAt)}`;
}

/** Where the "now" line goes among today's timed events: before the first one that hasn't started yet. Null when every event has started. */
export function nowIndex(today: EventDto[], now: Date): number | null {
  const timed = today.map((e, i) => ({ e, i })).filter(({ e }) => !e.allDay);
  if (timed.length === 0) return null;
  const next = timed.find(({ e }) => Date.parse(e.startsAt) > now.getTime());
  return next ? next.i : today.length;
}

export const isPast = (e: EventDto, now: Date) => !e.allDay && Date.parse(e.endsAt) <= now.getTime();
export const isNow = (e: EventDto, now: Date) => !e.allDay && Date.parse(e.startsAt) <= now.getTime() && Date.parse(e.endsAt) > now.getTime();

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The banner line: "3 events today · 2 tasks · 4 sessions running". */
export function todaySummary(c: { eventsToday: number | null; openTasks: number; running: number; idle?: number }): string {
  const parts = [
    ...(c.eventsToday === null ? [] : [c.eventsToday === 0 ? 'No events today' : `${plural(c.eventsToday, 'event')} today`]),
    plural(c.openTasks, 'task'),
    c.running === 0 ? 'nothing running' : `${plural(c.running, 'session')} running${c.idle ? ` (${c.idle} idle)` : ''}`,
  ];
  return parts.join(' · ');
}

export const openTasks = (tasks: TaskDto[]) => tasks.filter((t) => !t.completedAt);
export const doneToday = (tasks: TaskDto[]) => tasks.filter((t) => t.completedAt);

/** A project's Upcoming summary: "Next: Fri 3:00 PM · 2 open tasks". */
export function upcomingSummary(events: EventDto[], tasks: TaskDto[], now: Date): string {
  const next = events.filter((e) => Date.parse(e.endsAt) > now.getTime()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  const open = openTasks(tasks).length;
  const when = next ? `Next: ${whenText(next, now)}` : 'Nothing scheduled';
  return open ? `${when} · ${plural(open, 'open task')}` : when;
}

/** "Today 3:00 PM", "Tomorrow, all day", "Fri 3:00 PM". */
export function whenText(e: EventDto, now: Date): string {
  const start = new Date(e.startsAt);
  const label = dayLabel(start, now);
  const days = Math.round((startOfDay(start).getTime() - startOfDay(now).getTime()) / 86_400_000);
  // Within the week a weekday is enough; further out it needs the date too.
  const day = label === 'Today' || label === 'Tomorrow' || days >= 7 ? label : start.toLocaleDateString(undefined, { weekday: 'short' });
  return e.allDay ? `${day}, all day` : `${day} ${clock(start)}`;
}

// ---------------------------------------------------------------------------
// Quick-add preview: "Fidelity call · Fri Nov 27, 3:00 – 3:30 PM · reminder 15 min before · no project"

import type { ReminderDraft as Draft } from '../api.ts';
type Defaults = { eventMinutes: number; reminderMinutes: number; allDayReminderMinutes: number };

/** A draft's start as a local Date: YYYY-MM-DD is local midnight (new Date() would read it as UTC). */
export function localDate(s: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return new Date(+d[1], +d[2] - 1, +d[3]);
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : t;
}

const minutesText = (m: number) => {
  if (m === 0) return 'at the start';
  if (m % 1440 === 0) return `${plural(m / 1440, 'day')} before`;
  if (m % 60 === 0) return `${plural(m / 60, 'hour')} before`;
  return `${m} min before`;
};

/** All-day reminders count back from midnight: 900 → "9:00 AM the day before". */
export function allDayReminderText(m: number): string {
  if (m === 0) return 'at midnight';
  const daysBefore = Math.ceil(m / 1440);
  const at = new Date(2000, 0, 1, 0, (1440 - (m % 1440)) % 1440);
  const time = clock(at);
  return daysBefore === 1 ? `${time} the day before` : `${time}, ${daysBefore} days before`;
}

const DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };

/** "every Monday", "every 2 weeks", "every month, 6 times". */
export function describeRepeat(rule: string): string {
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]));
  const n = Number(parts.INTERVAL ?? 1);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[parts.FREQ] ?? 'time';
  const days = parts.BYDAY?.split(',').map((d) => DAYS[d.replace(/^[+-]?\d+/, '')] ?? d);
  let text = parts.FREQ === 'WEEKLY' && days && n === 1 ? `every ${days.join(' and ')}` : n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  if (parts.FREQ === 'WEEKLY' && days && n > 1) text += ` on ${days.join(' and ')}`;
  if (parts.COUNT) text += `, ${parts.COUNT} times`;
  if (parts.UNTIL) text += ` until ${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`;
  return text;
}

export function previewParts(d: Draft, defaults: Defaults, projectName: string | null): string[] {
  const { title, start, end, allDay, reminderMinutes, repeat } = d;
  const project = d.project ? (projectName ?? d.project) : 'no project';
  if (d.kind === 'task' || !start) return [title, 'task, no date', project];
  const s = localDate(start);
  if (!s) return [title, start, project];
  const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  let when: string;
  let reminder: string;
  if (allDay) {
    const last = end ? localDate(end) : null;
    when = last && last > s ? `${day} – ${last.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, all day` : `${day}, all day`;
    reminder = `reminder ${allDayReminderText(reminderMinutes ?? defaults.allDayReminderMinutes)}`;
  } else {
    const e = (end && localDate(end)) || new Date(s.getTime() + defaults.eventMinutes * 60_000);
    const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    when = `${day}, ${fmt.formatRange(s, e)}`;
    reminder = `reminder ${minutesText(reminderMinutes ?? defaults.reminderMinutes)}`;
  }
  return [title, when, reminder, ...(repeat ? [`repeats ${describeRepeat(repeat)}`] : []), project];
}

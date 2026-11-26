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

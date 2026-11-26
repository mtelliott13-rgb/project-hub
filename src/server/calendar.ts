// The calendar: the cached events the Today page shows, the sync that fills
// the cache, and createEvent, the one function every entry point (quick-add,
// the MCP tool, note suggestions) uses to add an event.
//
// Times use the Mac's time zone (Intl's resolved zone; never hard-coded).
// Timed events are sent to Google as RFC 3339 with that zone; all-day events
// as dates. Each event gets one popup reminder, the linked project's slug in
// extendedProperties.private.hubProject, and an optional repeat rule.
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { AuthRejected, ConnectorError } from './connectors/types.ts';
import type { Db } from './db/index.ts';
import { calendarEvents, projects, type CalendarEvent } from './db/schema.ts';
import { getSetting, setSetting } from './settings.ts';

export const SYNC_DAYS = 14;
export const MAX_REMINDER_MINUTES = 40_320; // Google's limit: 4 weeks
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, '0');
/** YYYY-MM-DD in local time. */
export const dateOnly = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** RFC 3339 with the local offset, e.g. 2026-11-27T15:00:00-05:00. */
export function rfc3339(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${dateOnly(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A local date (midnight), or null if it isn't a real YYYY-MM-DD. */
export function parseDate(s: string): Date | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return dateOnly(d) === s ? d : null;
}

/** A time: local wall-clock (YYYY-MM-DDTHH:MM) in the Mac's zone, or RFC 3339 with an offset. */
export function parseDateTime(s: string): Date | null {
  const m = LOCAL_RE.exec(s);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    return d.getDate() === +m[3] && d.getHours() === +m[4] ? d : null;
  }
  if (ZONED_RE.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repeat rules: a small, checked subset of RFC 5545 RRULE.

const DAY = '(?:[+-]?(?:[1-9]|[1-4]\\d|5[0-3]))?(?:MO|TU|WE|TH|FR|SA|SU)';
const RULE_PARTS: Record<string, RegExp> = {
  FREQ: /^(DAILY|WEEKLY|MONTHLY|YEARLY)$/,
  INTERVAL: /^([1-9]|[1-9]\d)$/,
  COUNT: /^([1-9]|[1-9]\d|[1-9]\d\d)$/,
  UNTIL: /^\d{8}(T\d{6}Z)?$/,
  BYDAY: new RegExp(`^${DAY}(,${DAY})*$`),
  BYMONTHDAY: /^-?([1-9]|[12]\d|3[01])(,-?([1-9]|[12]\d|3[01]))*$/,
  BYMONTH: /^([1-9]|1[0-2])(,([1-9]|1[0-2]))*$/,
};

/** "FREQ=WEEKLY;BYDAY=MO" (an "RRULE:" prefix is allowed), normalized; throws with a reason otherwise. */
export function checkRepeat(rule: string): string {
  const body = rule.trim().replace(/^RRULE:/i, '').toUpperCase();
  const seen = new Map<string, string>();
  for (const part of body.split(';').filter(Boolean)) {
    const [k, v, ...extra] = part.split('=');
    if (!k || v === undefined || extra.length || !RULE_PARTS[k]) throw new InputError(`Repeat rule part "${part}" isn't supported`);
    if (seen.has(k)) throw new InputError(`Repeat rule has ${k} twice`);
    if (!RULE_PARTS[k].test(v)) throw new InputError(`Repeat rule ${k}=${v} isn't valid`);
    seen.set(k, v);
  }
  if (!seen.has('FREQ')) throw new InputError('A repeat rule needs FREQ (DAILY, WEEKLY, MONTHLY or YEARLY)');
  if (seen.has('COUNT') && seen.has('UNTIL')) throw new InputError('A repeat rule can have COUNT or UNTIL, not both');
  return [...seen].map(([k, v]) => `${k}=${v}`).join(';');
}

// ---------------------------------------------------------------------------
// Defaults (Settings)

export type CalendarDefaults = { eventMinutes: number; reminderMinutes: number; allDayReminderMinutes: number };
/**
 * All-day reminders count back from midnight at the start of the day, so
 * "9:00 AM the day before" is 900 minutes (15 hours), Google's own default.
 */
export const DEFAULTS: CalendarDefaults = { eventMinutes: 30, reminderMinutes: 15, allDayReminderMinutes: 900 };
export const defaultsSchema = z
  .object({
    eventMinutes: z.number().int().min(5).max(24 * 60),
    reminderMinutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES),
    allDayReminderMinutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES),
  })
  .strict();

export function getDefaults(db: Db): CalendarDefaults {
  const saved = defaultsSchema.partial().safeParse(getSetting(db, 'calendar.defaults'));
  return { ...DEFAULTS, ...(saved.success ? saved.data : {}) };
}
export function setDefaults(db: Db, patch: Partial<CalendarDefaults>): CalendarDefaults {
  const next = defaultsSchema.parse({ ...getDefaults(db), ...patch });
  setSetting(db, 'calendar.defaults', next);
  return next;
}

// ---------------------------------------------------------------------------
// The event input every entry point sends.

/** A refusal whose message is safe to show (bad input, not a service failure). */
export class InputError extends Error {}

const slug = z.string().regex(/^[a-z0-9-]+$/);
export const eventInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    /** YYYY-MM-DD (all-day), YYYY-MM-DDTHH:MM in the Mac's time zone, or RFC 3339 with an offset. */
    start: z.string().max(40),
    /** Same forms. For all-day events, the last day (inclusive). Omit for the default length. */
    end: z.string().max(40).nullish(),
    allDay: z.boolean().optional(),
    reminderMinutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES).nullish(),
    repeat: z.string().max(200).nullish(),
    project: slug.nullish(),
  })
  .strict();
export type EventInput = z.infer<typeof eventInputSchema>;

/** A checked event, ready to send. All-day `end` is exclusive here, as Google wants it. */
export type EventDraft = {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  startsAt: Date;
  endsAt: Date;
  reminderMinutes: number;
  repeat: string | null;
  project: string | null;
};

export function normalizeEvent(input: EventInput, defaults: CalendarDefaults): EventDraft {
  const title = input.title.trim();
  const allDay = input.allDay ?? DATE_RE.test(input.start);
  const repeat = input.repeat ? checkRepeat(input.repeat) : null;
  const project = input.project ?? null;
  if (allDay) {
    const s = parseDate(input.start.slice(0, 10));
    if (!s) throw new InputError(`"${input.start}" isn't a date (YYYY-MM-DD)`);
    const last = input.end ? parseDate(input.end.slice(0, 10)) : s;
    if (!last) throw new InputError(`"${input.end}" isn't a date (YYYY-MM-DD)`);
    if (last < s) throw new InputError('The event ends before it starts');
    const endExcl = addDays(last, 1);
    if (endExcl.getTime() - s.getTime() > 366 * 86_400_000) throw new InputError('All-day events can be a year long at most');
    return { title, allDay, start: dateOnly(s), end: dateOnly(endExcl), startsAt: s, endsAt: endExcl, reminderMinutes: input.reminderMinutes ?? defaults.allDayReminderMinutes, repeat, project };
  }
  const s = parseDateTime(input.start);
  if (!s) throw new InputError(`"${input.start}" isn't a date and time`);
  const e = input.end ? parseDateTime(input.end) : new Date(s.getTime() + defaults.eventMinutes * 60_000);
  if (!e) throw new InputError(`"${input.end}" isn't a date and time`);
  if (e <= s) throw new InputError('The event ends before it starts');
  if (e.getTime() - s.getTime() > 31 * 86_400_000) throw new InputError('Events can be 31 days long at most');
  return { title, allDay, start: rfc3339(s), end: rfc3339(e), startsAt: s, endsAt: e, reminderMinutes: input.reminderMinutes ?? defaults.reminderMinutes, repeat, project };
}

/** The Calendar API's event body. */
export function googleEventBody(d: EventDraft, timeZone: string) {
  return {
    summary: d.title,
    start: d.allDay ? { date: d.start } : { dateTime: d.start, timeZone },
    end: d.allDay ? { date: d.end } : { dateTime: d.end, timeZone },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: d.reminderMinutes }] },
    extendedProperties: { private: { hubCreated: '1', ...(d.project ? { hubProject: d.project } : {}) } },
    ...(d.repeat ? { recurrence: [`RRULE:${d.repeat}`] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Google's event resource, as much as the hub reads.

const timeSchema = z.object({ date: z.string().optional(), dateTime: z.string().optional() });
export const googleEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  htmlLink: z.string().optional(),
  start: timeSchema,
  end: timeSchema,
  recurringEventId: z.string().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof googleEventSchema>;

/** A cache row from Google's event, or null for cancelled or unreadable ones. */
export function eventRow(e: GoogleEvent, syncedAt: Date): CalendarEvent | null {
  if (e.status === 'cancelled') return null;
  const allDay = !!e.start.date;
  const start = e.start.date ?? e.start.dateTime;
  const end = e.end.date ?? e.end.dateTime ?? start;
  if (!start || !end) return null;
  const startsAt = allDay ? parseDate(start) : parseDateTime(start);
  const endsAt = allDay ? parseDate(end) : parseDateTime(end);
  if (!startsAt || !endsAt) return null;
  const priv = e.extendedProperties?.private ?? {};
  const link = e.htmlLink && /^https:\/\/(www\.)?google\.com\/calendar\//.test(e.htmlLink) ? e.htmlLink : null;
  return {
    id: e.id,
    title: (e.summary ?? '').trim() || '(No title)',
    allDay,
    start,
    end,
    startsAt,
    endsAt,
    htmlLink: link,
    projectSlug: priv.hubProject && /^[a-z0-9-]+$/.test(priv.hubProject) ? priv.hubProject : null,
    recurring: !!e.recurringEventId,
    createdByHub: priv.hubCreated === '1',
    syncedAt,
  };
}

// ---------------------------------------------------------------------------
// Backends: Google, or (for `pnpm sample`) a local stand-in.

export interface CalendarBackend {
  /** Events between the two times on the primary calendar, plus the account name if known. */
  list(timeMin: Date, timeMax: Date, timeZone: string): Promise<{ account: string | null; items: GoogleEvent[] }>;
  insert(body: ReturnType<typeof googleEventBody>): Promise<GoogleEvent>;
  delete(id: string): Promise<void>;
  /** Whether it may make requests now (the connector is connected). */
  ready(): boolean;
}

export type CalendarDeps = { db: Db; backend: CalendarBackend; now?: () => Date; timeZone?: () => string; onChange?: () => void };

export function calendarService({ db, backend, now = () => new Date(), timeZone = localTimeZone, onChange = () => {} }: CalendarDeps) {
  const window = () => {
    const from = startOfDay(now());
    return { from, to: addDays(from, SYNC_DAYS + 1) };
  };

  /** Replaces the cache with what Google has for today through 14 days out. */
  async function sync(): Promise<{ account: string | null; count: number }> {
    const { from, to } = window();
    const { account, items } = await backend.list(from, to, timeZone());
    const at = now();
    const rows = items.map((e) => eventRow(e, at)).filter((r): r is CalendarEvent => r !== null);
    db.transaction((tx) => {
      tx.delete(calendarEvents).run();
      for (const r of rows) tx.insert(calendarEvents).values(r).onConflictDoNothing().run();
    });
    onChange();
    return { account, count: rows.length };
  }

  /** The one way to add an event. Throws InputError for bad input, ConnectorError for Google failures. */
  async function createEvent(input: unknown): Promise<CalendarEvent> {
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success) throw new InputError(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    const draft = normalizeEvent(parsed.data, getDefaults(db));
    if (draft.project && !db.select().from(projects).where(eq(projects.slug, draft.project)).get()) throw new InputError(`No project called "${draft.project}"`);
    if (!backend.ready()) throw new ConnectorError('not-connected', 'Connect Google Calendar first (Settings → Connections).');
    const created = await backend.insert(googleEventBody(draft, timeZone()));
    const row = eventRow(created, now()) ?? null;
    if (!row) throw new ConnectorError('bad-answer', 'Google created the event but sent back something unexpected. It will show after the next sync.');
    // Google answers a repeating event with the series itself; its later dates show after the next sync.
    if (draft.repeat) row.recurring = true;
    db.insert(calendarEvents).values(row).onConflictDoUpdate({ target: calendarEvents.id, set: row }).run();
    onChange();
    return row;
  }

  /** Undo: deletes an event, but only one the hub created. */
  async function deleteEvent(id: string): Promise<void> {
    const row = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get();
    if (!row) throw new InputError('No such event');
    if (!row.createdByHub) throw new InputError('Only events the hub added can be deleted from here');
    if (!backend.ready()) throw new ConnectorError('not-connected', 'Connect Google Calendar first (Settings → Connections).');
    await backend.delete(id);
    db.delete(calendarEvents).where(eq(calendarEvents.id, id)).run();
    onChange();
  }

  /** Cached events from the start of today through `days` days out, soonest first. */
  function list(days = SYNC_DAYS, slug?: string): CalendarEvent[] {
    const from = startOfDay(now());
    const to = addDays(from, days + 1);
    return db
      .select()
      .from(calendarEvents)
      .where(and(lt(calendarEvents.startsAt, to), gte(calendarEvents.endsAt, from), slug ? eq(calendarEvents.projectSlug, slug) : undefined))
      .orderBy(asc(calendarEvents.startsAt))
      .all()
      .filter((e) => e.endsAt > from || e.startsAt >= from);
  }

  return { sync, createEvent, deleteEvent, list, ready: () => backend.ready(), timeZone };
}

export type CalendarService = ReturnType<typeof calendarService>;

/** A Google error answer, reduced to a safe message. */
export async function googleFailure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; status?: string; details?: { reason?: string }[] } };
  const reasons = [...(body.error?.errors ?? []).map((e) => e.reason), ...(body.error?.details ?? []).map((d) => d.reason), body.error?.status];
  if (reasons.some((r) => r === 'accessNotConfigured' || r === 'SERVICE_DISABLED')) {
    return new ConnectorError('api-disabled', 'The Google Calendar API is turned off for your Google Cloud project. Enable it there, then click Sync now.');
  }
  if (reasons.some((r) => r === 'insufficientPermissions' || r === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return new AuthRejected('The Google sign-in is missing calendar access. Reconnect and allow it.');
  }
  if (res.status === 429 || reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded')) {
    return new ConnectorError('rate-limited', 'Google asked the hub to slow down. It will try again at the next sync.');
  }
  return new ConnectorError('http', `Google answered ${res.status} when ${what}.`);
}

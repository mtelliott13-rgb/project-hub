// The Today page's calendar API. Everything is under /api/*, so the app-wide
// check (hubPageRefusal) requires the page token, and for writes the hub's own
// Origin and JSON; the writes here also check Origin themselves.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { defaultsSchema, getDefaults, InputError, setDefaults, SYNC_DAYS, type CalendarService } from './calendar.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import { AuthRejected, ConnectorError } from './connectors/types.ts';
import type { CalendarEvent } from './db/schema.ts';
import type { Db } from './db/index.ts';
import { scrub } from './secrets.ts';

export type CalendarRouteDeps = { db: Db; calendar: CalendarService; connectors: ConnectorRegistry; origins: string[]; log?: (line: string) => void };

/** What the page gets for an event. */
export const eventDto = (e: CalendarEvent) => ({
  id: e.id,
  title: e.title,
  allDay: e.allDay,
  start: e.start,
  end: e.end,
  startsAt: e.startsAt.toISOString(),
  endsAt: e.endsAt.toISOString(),
  htmlLink: e.htmlLink,
  project: e.projectSlug,
  recurring: e.recurring,
  createdByHub: e.createdByHub,
});
export type EventDto = ReturnType<typeof eventDto>;

/** Turns a calendar failure into a safe answer. */
export function calendarFailure(c: Context, e: unknown, log: (line: string) => void = () => {}) {
  if (e instanceof InputError) return c.json({ error: e.message, code: 'bad-input' }, 400);
  if (e instanceof AuthRejected) return c.json({ error: scrub(e.message), code: 'needs-reconnect' }, 409);
  if (e instanceof ConnectorError) return c.json({ error: scrub(e.message), code: e.code }, e.code === 'not-connected' ? 409 : 502);
  log(`Calendar: unexpected failure: ${scrub(e instanceof Error ? e.message : String(e))}`);
  return c.json({ error: "Couldn't reach Google Calendar. Try again in a minute." }, 502);
}

export function addCalendarRoutes(app: Hono, { db, calendar, connectors, origins, log = () => {} }: CalendarRouteDeps) {
  const ownOrigin = (c: Context) => origins.includes(c.req.header('Origin') ?? '');
  const refuse = (c: Context) => c.json({ error: 'requests must come from the hub page (Origin)' }, 403);

  app.use('/api/calendar/*', bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'Too large' }, 413) }));

  app.get('/api/calendar', async (c) => {
    const days = Math.min(SYNC_DAYS, Math.max(1, Number(c.req.query('days') ?? SYNC_DAYS) || SYNC_DAYS));
    const slug = c.req.query('project');
    const status = await connectors.status('google');
    return c.json({
      timeZone: calendar.timeZone(),
      google: { state: status.state, account: status.account, lastSyncAt: status.lastSyncAt, error: status.error, canConnect: status.canConnect, sample: status.sample ?? false },
      events: calendar.list(days, slug && /^[a-z0-9-]+$/.test(slug) ? slug : undefined).map(eventDto),
    });
  });

  app.post('/api/calendar/events', async (c) => {
    if (!ownOrigin(c)) return refuse(c);
    try {
      return c.json({ event: eventDto(await calendar.createEvent(await c.req.json().catch(() => null))) });
    } catch (e) {
      return calendarFailure(c, e, log);
    }
  });

  app.delete('/api/calendar/events/:id', async (c) => {
    if (!ownOrigin(c)) return refuse(c);
    try {
      await calendar.deleteEvent(c.req.param('id'));
      return c.json({ ok: true });
    } catch (e) {
      return calendarFailure(c, e, log);
    }
  });

  app.get('/api/settings/calendar', (c) => c.json(getDefaults(db)));
  app.put('/api/settings/calendar', async (c) => {
    if (!ownOrigin(c)) return refuse(c);
    const parsed = defaultsSchema.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Lengths and reminders are whole minutes (reminders up to 40,320, 4 weeks).' }, 400);
    return c.json(setDefaults(db, parsed.data));
  });
}

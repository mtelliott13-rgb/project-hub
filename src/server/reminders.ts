// createReminder: the one way anything adds a reminder (quick-add, the MCP
// add_reminder tool, note suggestions). With a start it's a calendar event
// (calendar.createEvent); without one it's a task.
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { calendarFailure, eventDto } from './calendar-routes.ts';
import { InputError, MAX_REMINDER_MINUTES, type CalendarService } from './calendar.ts';
import type { CalendarEvent, Task } from './db/schema.ts';
import { taskDto, type TaskService } from './tasks.ts';
import type { Db } from './db/index.ts';
import { getSetting, setSetting } from './settings.ts';
import { BACKENDS, MAX_TEXT, parseQuickAdd, type Backend, type QuickAddDeps } from './quick-add.ts';

export const reminderInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    /** YYYY-MM-DD (all-day), YYYY-MM-DDTHH:MM in the Mac's time zone, or RFC 3339. No start: a task. */
    start: z.string().max(40).nullish(),
    end: z.string().max(40).nullish(),
    allDay: z.boolean().nullish(),
    reminderMinutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES).nullish(),
    repeat: z.string().max(200).nullish(),
    project: z.string().regex(/^[a-z0-9-]+$/).nullish(),
  })
  .strict();
export type ReminderInput = z.infer<typeof reminderInputSchema>;

export type Created = { kind: 'event'; event: CalendarEvent } | { kind: 'task'; task: Task };

export async function createReminder(deps: { calendar: CalendarService; tasks: TaskService }, input: unknown): Promise<Created> {
  const parsed = reminderInputSchema.safeParse(input);
  if (!parsed.success) throw new InputError(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  const r = parsed.data;
  if (!r.start) {
    if (r.end || r.repeat) throw new InputError('A reminder with an end or a repeat rule needs a start');
    return { kind: 'task', task: deps.tasks.create({ title: r.title, project: r.project ?? null }) };
  }
  const event = await deps.calendar.createEvent({
    title: r.title,
    start: r.start,
    end: r.end ?? null,
    ...(r.allDay != null && { allDay: r.allDay }),
    reminderMinutes: r.reminderMinutes ?? null,
    repeat: r.repeat ?? null,
    project: r.project ?? null,
  });
  return { kind: 'event', event };
}

export const createdDto = (c: Created) => (c.kind === 'event' ? { kind: c.kind, event: eventDto(c.event) } : { kind: c.kind, task: taskDto(c.task) });

/** POST /api/reminders: what the page sends once you confirm. Under /api/* (page token, Origin, JSON); Origin checked again here. */
export function addReminderRoutes(app: Hono, deps: { calendar: CalendarService; tasks: TaskService; origins: string[] }) {
  app.post('/api/reminders', async (c: Context) => {
    if (!deps.origins.includes(c.req.header('Origin') ?? '')) return c.json({ error: 'requests must come from the hub page (Origin)' }, 403);
    try {
      return c.json(createdDto(await createReminder(deps, await c.req.json().catch(() => null))));
    } catch (e) {
      return calendarFailure(c, e);
    }
  });
}

/** Settings → Quick-add parser. Claude Code by default; `pnpm sample` defaults to None (it makes no outside requests). */
export function quickAddBackend(db: Db, sample = false): Backend {
  const v = getSetting(db, 'quickadd.backend');
  return BACKENDS.includes(v as Backend) ? (v as Backend) : sample ? 'none' : 'claude-cli';
}

export function addQuickAddRoutes(app: Hono, deps: { db: Db; origins: string[]; sample?: boolean; quickAdd: Omit<QuickAddDeps, 'backend'> }) {
  const own = (c: Context) => deps.origins.includes(c.req.header('Origin') ?? '');
  const backend = () => quickAddBackend(deps.db, deps.sample);
  // Reads the text and returns a draft (or the form). Creates nothing.
  app.post('/api/quick-add', async (c) => {
    if (!own(c)) return c.json({ error: 'requests must come from the hub page (Origin)' }, 403);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_TEXT) return c.json({ error: `Type a reminder (${MAX_TEXT} characters at most)` }, 400);
    return c.json(await parseQuickAdd(text, { ...deps.quickAdd, backend }));
  });
  app.get('/api/settings/quick-add', (c) => c.json({ backend: backend() }));
  app.put('/api/settings/quick-add', async (c) => {
    if (!own(c)) return c.json({ error: 'requests must come from the hub page (Origin)' }, 403);
    const body = (await c.req.json().catch(() => null)) as { backend?: unknown } | null;
    if (!BACKENDS.includes(body?.backend as Backend)) return c.json({ error: `backend is one of ${BACKENDS.join(', ')}` }, 400);
    setSetting(deps.db, 'quickadd.backend', body!.backend);
    return c.json({ backend: backend() });
  });
}

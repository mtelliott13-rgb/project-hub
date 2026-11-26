// Tasks: reminders without a date, on the Today page and each project's
// Upcoming section. Stored in the `tasks` table: title, optional project,
// created time, completed time. "Add date" turns one into a calendar event
// through createEvent and then removes the task.
import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { calendarFailure, eventDto } from './calendar-routes.ts';
import { InputError, startOfDay, type CalendarService } from './calendar.ts';
import type { Db } from './db/index.ts';
import { projects, tasks, type Task } from './db/schema.ts';

const slug = z.string().regex(/^[a-z0-9-]+$/);
export const taskInputSchema = z.object({ title: z.string().trim().min(1).max(300), project: slug.nullish() }).strict();

export function taskService(db: Db, now: () => Date = () => new Date(), onChange: () => void = () => {}) {
  const checkProject = (p: string | null | undefined) => {
    if (p && !db.select().from(projects).where(eq(projects.slug, p)).get()) throw new InputError(`No project called "${p}"`);
  };
  const get = (id: number) => db.select().from(tasks).where(eq(tasks.id, id)).get();
  return {
    /** Open tasks (oldest first), then those completed today (newest first). */
    list(project?: string): Task[] {
      const byProject = project ? eq(tasks.projectSlug, project) : undefined;
      const open = db.select().from(tasks).where(and(isNull(tasks.completedAt), byProject)).orderBy(asc(tasks.createdAt), asc(tasks.id)).all();
      const done = db.select().from(tasks).where(and(gte(tasks.completedAt, startOfDay(now())), byProject)).orderBy(desc(tasks.completedAt)).all();
      return [...open, ...done];
    },
    get,
    create(input: unknown): Task {
      const parsed = taskInputSchema.safeParse(input);
      if (!parsed.success) throw new InputError('A task needs a title (300 characters at most) and, optionally, a project slug');
      checkProject(parsed.data.project);
      const row = db.insert(tasks).values({ title: parsed.data.title, projectSlug: parsed.data.project ?? null, createdAt: now() }).returning().get();
      onChange();
      return row;
    },
    update(id: number, patch: { done?: boolean; project?: string | null; title?: string }): Task {
      if (!get(id)) throw new InputError('No such task');
      if (patch.project !== undefined) checkProject(patch.project);
      db.update(tasks)
        .set({
          ...(patch.done !== undefined && { completedAt: patch.done ? now() : null }),
          ...(patch.project !== undefined && { projectSlug: patch.project }),
          ...(patch.title !== undefined && { title: patch.title }),
        })
        .where(eq(tasks.id, id))
        .run();
      onChange();
      return get(id)!;
    },
    remove(id: number) {
      const n = db.delete(tasks).where(eq(tasks.id, id)).run().changes;
      if (!n) throw new InputError('No such task');
      onChange();
    },
    /** Open-task counts per project, for summaries. */
    openCounts(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const t of db.select().from(tasks).where(isNull(tasks.completedAt)).all()) if (t.projectSlug) out[t.projectSlug] = (out[t.projectSlug] ?? 0) + 1;
      return out;
    },
  };
}
export type TaskService = ReturnType<typeof taskService>;

export const taskDto = (t: Task) => ({ id: t.id, title: t.title, project: t.projectSlug, createdAt: t.createdAt.toISOString(), completedAt: t.completedAt?.toISOString() ?? null });
export type TaskDto = ReturnType<typeof taskDto>;

const patchSchema = z.object({ done: z.boolean().optional(), project: slug.nullable().optional(), title: z.string().trim().min(1).max(300).optional() }).strict();
const scheduleSchema = z
  .object({
    start: z.string().max(40),
    end: z.string().max(40).nullish(),
    allDay: z.boolean().optional(),
    reminderMinutes: z.number().int().nullish(),
    repeat: z.string().max(200).nullish(),
  })
  .strict();

/** Under /api/*: the page token, and for writes the hub's Origin and JSON (hubPageRefusal); writes check Origin again here. */
export function addTaskRoutes(app: Hono, { tasks: svc, calendar, origins }: { tasks: TaskService; calendar: CalendarService; origins: string[] }) {
  const ownOrigin = (c: Context) => origins.includes(c.req.header('Origin') ?? '');
  const refuse = (c: Context) => c.json({ error: 'requests must come from the hub page (Origin)' }, 403);
  const id = (c: Context) => Number(c.req.param('id'));
  const fail = (c: Context, e: unknown) => (e instanceof InputError ? c.json({ error: e.message }, e.message === 'No such task' ? 404 : 400) : calendarFailure(c, e));

  app.get('/api/tasks', (c) => {
    const p = c.req.query('project');
    return c.json(svc.list(p && /^[a-z0-9-]+$/.test(p) ? p : undefined).map(taskDto));
  });
  app.post('/api/tasks', async (c) => {
    if (!ownOrigin(c)) return refuse(c);
    try {
      return c.json({ task: taskDto(svc.create(await c.req.json().catch(() => null))) });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.put('/api/tasks/:id', async (c) => {
    if (!ownOrigin(c)) return refuse(c);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Expected { done?, project?, title? }' }, 400);
    try {
      return c.json({ task: taskDto(svc.update(id(c), parsed.data)) });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.delete('/api/tasks/:id', (c) => {
    if (!ownOrigin(c)) return refuse(c);
    try {
      svc.remove(id(c));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
  // "Add date": the task becomes a calendar event (same createEvent as every
  // other entry point), and the task is removed only once Google has it.
  app.post('/api/tasks/:id/schedule', async (c) => {
    if (!ownOrigin(c)) return refuse(c);
    const t = svc.get(id(c));
    if (!t) return c.json({ error: 'No such task' }, 404);
    const parsed = scheduleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Expected { start, end?, allDay?, reminderMinutes?, repeat? }' }, 400);
    try {
      const event = await calendar.createEvent({ title: t.title, project: t.projectSlug, ...parsed.data });
      svc.remove(t.id);
      return c.json({ event: eventDto(event), removedTask: taskDto(t) });
    } catch (e) {
      return fail(c, e);
    }
  });
}

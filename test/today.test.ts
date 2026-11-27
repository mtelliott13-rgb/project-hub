// Today page (phase 3): tasks, "Add date", the landing page setting, the
// Upcoming summary and the page's day rules. No network: the calendar uses the
// local stand-in, or a fake that fails on purpose.
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { ConnectorError } from '../src/server/connectors/types.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { tasks } from '../src/server/db/schema.ts';
import type { CalendarBackend } from '../src/server/calendar.ts';
import { sampleCalendarBackend } from '../src/server/connectors/google-calendar.ts';
import type { EventDto, TaskDto } from '../web/src/api.ts';
import { agenda, nowIndex, todaySummary, upcomingSummary, whenText } from '../web/src/today/model.ts';
import { route } from '../web/src/router.tsx';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const PAGE_WRITE = { ...PAGE_GET, Origin: HUB, 'Content-Type': 'application/json' };

function setup(backend?: CalendarBackend, now?: () => Date) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-today-'));
  dirs.push(dir);
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db, { calendarBackend: backend ? () => backend : undefined, now });
  fs.writeFileSync(t.projectsFile, 'projects:\n  - slug: demo\n    name: Demo\n');
  t.store.reload();
  const web = path.join(dir, 'web');
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'index.html'), '<html><head></head><body></body></html>');
  const app = createApp({ ...t.deps, webDir: web });
  const req = (p: string, init: RequestInit = {}) => app.request(`${HUB}${p}`, init);
  return { db, t, req };
}

describe('tasks', () => {
  it('creates, lists, completes into "done today", reopens and deletes', async () => {
    const { req } = setup();
    let r = await req('/api/tasks', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: '  Buy stamps ', project: 'demo' }) });
    const { task } = await r.json();
    expect(task).toMatchObject({ title: 'Buy stamps', project: 'demo', completedAt: null });
    await req('/api/tasks', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ title: 'Call the bank' }) });

    r = await req(`/api/tasks/${task.id}`, { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ done: true }) });
    expect((await r.json()).task.completedAt).toEqual(expect.any(String));
    let list: TaskDto[] = await (await req('/api/tasks', { headers: PAGE_GET })).json();
    // Open first, then done today.
    expect(list.map((t) => [t.title, !!t.completedAt])).toEqual([
      ['Call the bank', false],
      ['Buy stamps', true],
    ]);
    list = await (await req('/api/tasks?project=demo', { headers: PAGE_GET })).json();
    expect(list.map((t) => t.title)).toEqual(['Buy stamps']);

    await req(`/api/tasks/${task.id}`, { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ done: false }) });
    r = await req(`/api/tasks/${task.id}`, { method: 'DELETE', headers: { ...PAGE_GET, Origin: HUB } });
    expect(r.status).toBe(200);
    r = await req(`/api/tasks/${task.id}`, { method: 'DELETE', headers: { ...PAGE_GET, Origin: HUB } });
    expect(r.status).toBe(404);
  });

  it('tasks completed before today drop off the list', async () => {
    const { db, t } = setup();
    const old = t.tasks.create({ title: 'Old' });
    t.tasks.create({ title: 'Open' });
    db.update(tasks).set({ completedAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(tasks.id, old.id)).run();
    expect(t.tasks.list().map((x) => x.title)).toEqual(['Open']);
  });

  it('refuses bad input, unknown projects and other origins', async () => {
    const { req, t } = setup();
    for (const body of [{ title: '' }, { title: 'x', project: 'nope' }, { title: 'x', extra: 1 }]) {
      expect((await req('/api/tasks', { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify(body) })).status).toBe(400);
    }
    for (const headers of [{ ...PAGE_WRITE, Origin: 'https://evil.example.com' }, { ...PAGE_GET, 'Content-Type': 'application/json' }]) {
      expect((await req('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'x' }) })).status).toBe(403);
    }
    const id = t.tasks.create({ title: 'Keep me' }).id;
    expect((await req(`/api/tasks/${id}`, { method: 'DELETE', headers: { ...PAGE_GET, Origin: 'https://evil.example.com' } })).status).toBe(403);
    expect((await req(`/api/tasks/${id}/schedule`, { method: 'POST', headers: { ...PAGE_WRITE, Origin: 'https://evil.example.com' }, body: '{"start":"2030-01-01"}' })).status).toBe(403);
    expect(t.tasks.list()).toHaveLength(1);
  });

  it('a deleted project leaves its tasks unfiled', async () => {
    const { t } = setup();
    t.tasks.create({ title: 'Filed', project: 'demo' });
    t.store.remove('demo');
    expect(t.tasks.list()[0].projectSlug).toBeNull();
  });
});

describe('Add date', () => {
  it('turns a task into an event (same createEvent) and removes the task', async () => {
    const { req, t } = setup(sampleCalendarBackend());
    const task = t.tasks.create({ title: 'Dentist', project: 'demo' });
    const r = await req(`/api/tasks/${task.id}/schedule`, { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ start: '2030-06-02T09:30', allDay: false }) });
    expect(r.status).toBe(200);
    const { event } = await r.json();
    expect(event).toMatchObject({ title: 'Dentist', project: 'demo', allDay: false, createdByHub: true });
    expect(t.tasks.list()).toEqual([]);
  });

  it('keeps the task when the calendar refuses', async () => {
    const failing: CalendarBackend = {
      ...sampleCalendarBackend(),
      insert: async () => {
        throw new ConnectorError('http', 'Google answered 500 when adding the event.');
      },
    };
    const { req, t } = setup(failing);
    const task = t.tasks.create({ title: 'Dentist' });
    const r = await req(`/api/tasks/${task.id}/schedule`, { method: 'POST', headers: PAGE_WRITE, body: JSON.stringify({ start: '2030-06-02' }) });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain('500');
    expect(t.tasks.list()).toHaveLength(1);
  });
});

describe('landing page', () => {
  it('defaults to Today, can switch to Projects, and the page carries the choice', async () => {
    const { req } = setup();
    let html = await (await req('/')).text();
    expect(html).toContain('<meta name="hub-landing" content="today" />');
    let r = await req('/api/settings/general', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ landing: 'projects' }) });
    expect(await r.json()).toEqual({ landing: 'projects' });
    html = await (await req('/')).text();
    expect(html).toContain('content="projects"');
    r = await req('/api/settings/general', { method: 'PUT', headers: PAGE_WRITE, body: JSON.stringify({ landing: 'inbox' }) });
    expect(r.status).toBe(400);
    r = await req('/api/settings/general', { method: 'PUT', headers: { ...PAGE_WRITE, Origin: 'https://evil.example.com' }, body: JSON.stringify({ landing: 'today' }) });
    expect(r.status).toBe(403);
  });

  it('routes: / follows the setting, /today and /projects are fixed', () => {
    expect(route('/', 'today')).toEqual({ page: 'today' });
    expect(route('/', 'projects')).toEqual({ page: 'home' });
    expect(route('/today', 'projects')).toEqual({ page: 'today' });
    expect(route('/projects', 'today')).toEqual({ page: 'home' });
    expect(route('/p/demo')).toEqual({ page: 'project', slug: 'demo' });
  });
});

// ---------------------------------------------------------------------------
// The page's rules (web/src/today/model.ts)

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
let n = 0;
function ev(title: string, start: Date, end: Date, allDay = false, project: string | null = null): EventDto {
  return { id: `e${n++}`, title, allDay, start: '', end: '', startsAt: start.toISOString(), endsAt: end.toISOString(), htmlLink: null, project, recurring: false, createdByHub: false };
}

describe('Today rules', () => {
  const now = at(2030, 3, 4, 13, 0); // a Monday, 1 PM
  const events = [
    ev('Lunch', at(2030, 3, 4, 12), at(2030, 3, 4, 13)),
    ev('Standup', at(2030, 3, 4, 9), at(2030, 3, 4, 9, 15)),
    ev('Holiday', at(2030, 3, 4), at(2030, 3, 5), true),
    ev('Call', at(2030, 3, 4, 15), at(2030, 3, 4, 15, 30), false, 'demo'),
    ev('Trip', at(2030, 3, 6), at(2030, 3, 8), true),
    ev('Overnight', at(2030, 3, 3, 22), at(2030, 3, 4, 14)),
    ev('Far', at(2030, 3, 20, 10), at(2030, 3, 20, 11)),
  ];

  it('today: all-day first, then by time, including what started yesterday and is still going', () => {
    const { today, next } = agenda(events, now);
    expect(today.map((e) => e.title)).toEqual(['Holiday', 'Overnight', 'Standup', 'Lunch', 'Call']);
    expect(next).toHaveLength(7);
    expect(next[0].label).toBe('Tomorrow');
    // A two-day all-day event shows on both days it covers.
    expect(next[1].events.map((e) => e.title)).toEqual(['Trip']);
    expect(next[2].events.map((e) => e.title)).toEqual(['Trip']);
    expect(next.flatMap((d) => d.events).some((e) => e.title === 'Far')).toBe(false);
  });

  it('the now line goes before the first event that has not started', () => {
    const { today } = agenda(events, now);
    expect(nowIndex(today, now)).toBe(4); // before Call
    expect(nowIndex(today, at(2030, 3, 4, 20))).toBe(5); // after everything
    expect(nowIndex([events[2]], now)).toBeNull(); // only all-day
  });

  it('summaries', () => {
    expect(todaySummary({ eventsToday: 3, openTasks: 2, running: 4 })).toBe('3 events today · 2 tasks · 4 sessions running');
    expect(todaySummary({ eventsToday: 1, openTasks: 1, running: 2, idle: 1 })).toBe('1 event today · 1 task · 2 sessions running (1 idle)');
    expect(todaySummary({ eventsToday: null, openTasks: 0, running: 0 })).toBe('0 tasks · nothing running');
    const task = (done: boolean): TaskDto => ({ id: 1, title: 't', project: 'demo', createdAt: now.toISOString(), completedAt: done ? now.toISOString() : null });
    expect(upcomingSummary([events[3]], [task(false), task(false), task(true)], now)).toMatch(/^Next: Today \d{1,2}:00\s?PM · 2 open tasks$/);
    expect(upcomingSummary([], [], now)).toBe('Nothing scheduled');
    expect(whenText(events[4], now)).toMatch(/, all day$/);
    expect(whenText(events[6], now)).toMatch(/Mar 20/);
  });
});

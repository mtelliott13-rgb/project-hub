// Read-only answers for the hub's MCP server (Phase 9, scripts/mcp.ts), so any
// Claude Code session or the Claude desktop app on this Mac can ask about the
// projects. GET only, with its own token (~/.project-hub/agent-token), and any
// request that looks like it came from a browser (Origin or Sec-Fetch-Site) is
// refused, so no web page can use these even with the token.
//
// What each route returns is exactly what the MCP tools return; the field
// lists are pinned by test/phase9.test.ts. Never notes, Monetize drafts, file
// contents or tokens, and the hub stores no prompt text at all.
//
// One exception to "GET only": POST /agent/v1/reminders (the add_reminder
// tool) adds one reminder through createReminder, the same function the Today
// page uses. Same token, same refusal of anything that looks like a browser.
import fs from 'node:fs';
import os from 'node:os';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { buildTimeline, describeEvent, isStale, lastActivity, sortProjects, statusBadges, type ActivityEvent } from './activity.ts';
import { listAllProjects, type Db } from './db/index.ts';
import type { Project, Session } from './db/schema.ts';
import type { FileWatcher } from './files.ts';
import { parseIdeas } from './ideas.ts';
import { activityInputs, toolkitSummary } from './project-summary.ts';
import type { RepoPoller } from './repos.ts';
import { resumeProblem, sessionsForProjects } from './sessions.ts';
import { tokenMatches } from './token.ts';
import { findToolkitFiles, readToolkit } from './toolkit.ts';
import { InputError, localTimeZone, type CalendarService } from './calendar.ts';
import { AuthRejected, ConnectorError } from './connectors/types.ts';
import { createReminder } from './reminders.ts';
import type { TaskService } from './tasks.ts';
import { scrub } from './secrets.ts';

export type AgentDeps = {
  db: Db;
  repos: RepoPoller;
  files: FileWatcher;
  ideasFile: string;
  /** ~/.project-hub/agent-token: read-only, accepted on /agent/* and nowhere else. */
  agentToken: string;
  home?: string;
  /** For list_agenda and add_reminder. */
  calendar: CalendarService;
  tasks: TaskService;
};

/** The one write route. */
export const AGENT_WRITE_PATH = '/agent/v1/reminders';

const MAX_SESSIONS = 50;

/** "4m ago", "3h ago", "12d ago": computed here so the answer doesn't depend on the model's sense of time. */
export function agoText(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function addAgentRoutes(app: Hono, { db, repos, files, ideasFile, agentToken, home = os.homedir(), calendar, tasks }: AgentDeps) {
  const short = (p: string) => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
  const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());

  app.use(AGENT_WRITE_PATH, bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'Too large' }, 413) }));
  app.use('/agent/*', async (c, next) => {
    if (c.req.header('Origin') || c.req.header('Sec-Fetch-Site')) return c.json({ error: 'Not for browsers' }, 403);
    const write = c.req.method === 'POST' && c.req.path === AGENT_WRITE_PATH;
    if (c.req.method !== 'GET' && !write) return c.json({ error: 'Read-only' }, 405);
    if (!tokenMatches(agentToken, c.req.header('X-Agent-Token'))) return c.json({ error: 'Wrong or missing agent token' }, 401);
    if (write && !(c.req.header('Content-Type') ?? '').startsWith('application/json')) return c.json({ error: 'Send JSON' }, 415);
    await next();
  });

  const event = (e: ActivityEvent) => ({
    kind: e.kind,
    what: describeEvent(e),
    at: e.at,
    ago: agoText(e.at),
    ...('url' in e && e.url ? { url: e.url } : {}),
  });

  const ideas = () => parseIdeas(fs.existsSync(ideasFile) ? fs.readFileSync(ideasFile, 'utf8') : '');
  const idea = (i: ReturnType<typeof parseIdeas>[number]) => ({ text: i.text, scope: i.scope, added: i.added, done: i.done, doneOn: i.doneOn });

  const session = (s: Session, names: Map<string, string>) => {
    const problem = resumeProblem(s, (dir) => fs.existsSync(dir));
    const at = iso(s.lastActiveAt);
    return {
      id: s.id,
      title: s.title,
      project: s.projectSlug,
      projectName: s.projectSlug ? (names.get(s.projectSlug) ?? null) : null,
      state: s.state,
      lastActive: at,
      ago: agoText(at),
      branch: s.gitBranch,
      folder: short(s.cwd),
      canResume: problem === null,
      ...(problem === null ? { resume: `claude --resume ${s.id}` } : { whyNotResumable: problem }),
    };
  };
  /** Sessions the page lists: reopenable or running (the rest never held a conversation). */
  const listedSessions = (slugs: string[]) =>
    sessionsForProjects(db, slugs).filter((s) => s.state === 'running' || resumeProblem(s, (dir) => fs.existsSync(dir)) === null);

  const summary = (p: Project, events: ActivityEvent[]) => {
    const last = lastActivity(events);
    const stale = !p.archived && isStale(last);
    const sessions = sessionsForProjects(db, [p.slug]);
    const repoStatus = p.repos.map((dir) => repos.get(dir));
    const t = toolkitSummary(p);
    return {
      slug: p.slug,
      name: p.name,
      archived: p.archived,
      badges: statusBadges({ sessions, repoStatus }, stale).map((b) => b.label),
      runningSessions: sessions.filter((s) => s.state === 'running').length,
      lastActivity: last ? event(last) : null,
      stale,
      toolkit: t ? (t.error ? `toolkit.yaml can't be read: ${t.error}` : `${t.done} of ${t.total} done`) : null,
      openIdeas: ideas().filter((i) => !i.done && i.scope === p.slug).length,
    };
  };

  const toolkit = (p: Project) => {
    const [file] = findToolkitFiles(p);
    if (!file) return null;
    const t = readToolkit(file);
    const day = today();
    return {
      file: short(file),
      done: t.done,
      total: t.total,
      items: t.items.map((i) => ({
        name: i.name,
        category: i.category,
        status: i.unknownStatus ?? i.status,
        cost: i.cost,
        why: i.why,
        notes: i.notes,
        target: i.target,
        overdue: !!i.target && i.target < day && i.status !== 'done' && i.status !== 'parked',
        url: i.url,
        // Hours to finish (a number, "ongoing", or as written when it's neither), and why.
        hours: i.hours ?? i.hoursText,
        timeNote: i.timeNote,
        priority: i.priority ?? i.unknownPriority,
        priorityWhy: i.priorityWhy,
      })),
      problems: t.problems,
    };
  };

  const find = (slug: string) => listAllProjects(db).find((p) => p.slug === slug);

  /** list_projects */
  app.get('/agent/v1/projects', (c) => {
    const withArchived = c.req.query('archived') === '1';
    const all = listAllProjects(db).filter((p) => withArchived || !p.archived);
    const inputs = activityInputs({ db, repos, files }, all.map((p) => p.slug));
    // Home page order: running first, then newest activity; archived ones last.
    const rows = all.map((p) => ({ p, sessions: sessionsForProjects(db, [p.slug]), name: p.name, row: summary(p, buildTimeline(inputs.get(p.slug)!)) }));
    const activity = Object.fromEntries(rows.map((r) => [r.p.slug, { last: r.row.lastActivity && { at: r.row.lastActivity.at } as ActivityEvent, stale: r.row.stale }]));
    const sorted = sortProjects(rows, activity, (r) => r.p.slug).sort((a, b) => Number(a.p.archived) - Number(b.p.archived));
    return c.json({ now: new Date().toISOString(), projects: sorted.map((r) => r.row) });
  });

  /** get_project */
  app.get('/agent/v1/projects/:slug', (c) => {
    const p = find(c.req.param('slug'));
    if (!p) return c.json({ error: `No project "${c.req.param('slug')}". list_projects gives the slugs.` }, 404);
    const events = buildTimeline(activityInputs({ db, repos, files }, [p.slug]).get(p.slug)!);
    const names = new Map([[p.slug, p.name]]);
    let tk: ReturnType<typeof toolkit> | { error: string } = null;
    try {
      tk = toolkit(p);
    } catch (e) {
      tk = { error: e instanceof Error ? e.message : String(e) };
    }
    const t = tk && 'items' in tk ? tk : null;
    return c.json({
      now: new Date().toISOString(),
      ...summary(p, events),
      folders: [...p.repos, ...p.folders].map(short),
      repos: p.repos.map((dir) => {
        const s = repos.get(dir);
        return {
          path: short(dir),
          checked: s?.checkedAt ?? null,
          github: s?.github?.repo ?? null,
          branch: s?.git?.branch ?? null,
          uncommitted: s?.git?.uncommitted ?? null,
          ahead: s?.git?.ahead ?? null,
          behind: s?.git?.behind ?? null,
          ci: s?.github?.ci ? { result: s.github.ci.state, workflow: s.github.ci.workflow, url: s.github.ci.url, at: s.github.ci.at } : null,
          openPrs: (s?.github?.prs ?? []).map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, draft: pr.draft, checks: pr.checks })),
          error: s?.gitError ?? s?.githubError ?? (s ? null : 'not checked yet'),
        };
      }),
      recentSessions: listedSessions([p.slug]).slice(0, 10).map((s) => session(s, names)),
      toolkitDetail: tk && 'error' in tk
        ? tk
        : t && {
            file: t.file,
            byStatus: Object.fromEntries(['not started', 'in progress', 'done', 'parked'].map((st) => [st, t.items.filter((i) => i.status === st).length])),
            inProgress: t.items.filter((i) => i.status === 'in progress').map((i) => i.name),
            overdue: t.items.filter((i) => i.overdue).map((i) => ({ name: i.name, target: i.target })),
          },
      ideas: ideas().filter((i) => !i.done && i.scope === p.slug).map(idea),
      timeline: events.slice(0, 20).map(event),
    });
  });

  /** recent_sessions */
  app.get('/agent/v1/sessions', (c) => {
    const slug = c.req.query('slug');
    const all = listAllProjects(db);
    if (slug && !all.some((p) => p.slug === slug)) return c.json({ error: `No project "${slug}". list_projects gives the slugs.` }, 404);
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 10, 1), MAX_SESSIONS);
    const names = new Map(all.map((p) => [p.slug, p.name]));
    const list = listedSessions(slug ? [slug] : all.map((p) => p.slug)).sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
    return c.json({ now: new Date().toISOString(), sessions: list.slice(0, limit).map((s) => session(s, names)) });
  });

  /** list_ideas */
  app.get('/agent/v1/ideas', (c) => {
    const scope = c.req.query('scope');
    const withDone = c.req.query('done') === '1';
    return c.json({ ideas: ideas().filter((i) => (withDone || !i.done) && (!scope || i.scope === scope)).map(idea) });
  });

  /** get_toolkit */
  app.get('/agent/v1/projects/:slug/toolkit', (c) => {
    const p = find(c.req.param('slug'));
    if (!p) return c.json({ error: `No project "${c.req.param('slug')}". list_projects gives the slugs.` }, 404);
    try {
      const t = toolkit(p);
      return t ? c.json({ project: p.slug, ...t }) : c.json({ error: `${p.name} has no toolkit.yaml.` }, 404);
    } catch (e) {
      return c.json({ error: `toolkit.yaml can't be read: ${e instanceof Error ? e.message : e}` }, 422);
    }
  });

  // ---------------------------------------------------------------------------
  // Today page: the agenda (read) and add_reminder (the one write).

  const agendaEvent = (e: ReturnType<CalendarService['list']>[number], names: Map<string, string>) => ({
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    project: e.projectSlug,
    projectName: e.projectSlug ? (names.get(e.projectSlug) ?? null) : null,
    repeats: e.recurring,
    link: e.htmlLink,
  });

  /** list_agenda */
  app.get('/agent/v1/agenda', (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 7, 1), 14);
    const names = new Map(listAllProjects(db).map((p) => [p.slug, p.name]));
    return c.json({
      now: new Date().toISOString(),
      timeZone: localTimeZone(),
      days,
      calendarConnected: calendar.ready(),
      events: calendar.list(days).map((e) => agendaEvent(e, names)),
      openTasks: tasks
        .list()
        .filter((t) => !t.completedAt)
        .map((t) => ({ title: t.title, project: t.projectSlug, projectName: t.projectSlug ? (names.get(t.projectSlug) ?? null) : null, added: iso(t.createdAt) })),
    });
  });

  /** add_reminder: the MCP server's only write. */
  app.post(AGENT_WRITE_PATH, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      const made = await createReminder({ calendar, tasks }, body);
      const names = new Map(listAllProjects(db).map((p) => [p.slug, p.name]));
      return c.json(
        made.kind === 'event'
          ? { added: 'event', ...agendaEvent(made.event, names) }
          : { added: 'task', title: made.task.title, project: made.task.projectSlug, projectName: made.task.projectSlug ? (names.get(made.task.projectSlug) ?? null) : null },
      );
    } catch (e) {
      if (e instanceof InputError) return c.json({ error: e.message }, 400);
      if (e instanceof AuthRejected) return c.json({ error: 'Google Calendar needs reconnecting on the hub (Today page → Reconnect).' }, 409);
      if (e instanceof ConnectorError) return c.json({ error: scrub(e.message) }, e.code === 'not-connected' ? 409 : 502);
      return c.json({ error: "Couldn't add it; see the hub log." }, 500);
    }
  });
}

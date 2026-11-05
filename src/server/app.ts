import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { desc, eq, isNotNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { listAllProjects, type Db } from './db/index.ts';
import { chats, links, projects, sessions } from './db/schema.ts';
import {
  collectorDir,
  collectorLaunchSchema,
  findCollector,
  planCollectorStart,
  planCollectorStop,
  sourceHealth,
  type ProcessProbe,
} from './collector.ts';
import { addDocRoutes, type DocDeps } from './doc-routes.ts';
import type { FileWatcher } from './files.ts';
import { addLinkRoutes, projectFileFilter } from './link-routes.ts';
import { buildTimeline, isStale, lastActivity, type ProjectActivity } from './activity.ts';
import { addAgentRoutes } from './agent-routes.ts';
import { addApplicationRoutes } from './application-routes.ts';
import { findQueueFiles, packetFile as findPacketFile, PACKET_FILES, queueRoot, queueSummary, readQueue } from './applications.ts';
import { activityInputs as gatherActivity, toolkitSummary } from './project-summary.ts';
import { addChatRoutes } from './chat-routes.ts';
import type { RepoPoller } from './repos.ts';
import { findToolkitFiles, readToolkit, STATUSES, ToolkitError, writeToolkitStatus, type ToolkitStatus } from './toolkit.ts';
import type { ChangeFeed } from './events.ts';
import { browse, checkPaths, FolderError, suggestions } from './folders.ts';
import { describePlan, LaunchError, launchRequestSchema, planLaunch, type Launcher } from './launcher.ts';
import type { ProjectStore } from './project-store.ts';
import { projectInputSchema, ProjectsFileError } from './projects-file.ts';
import { applyHookEvent, hookPayloadSchema, resumeProblem, sessionsForProjects } from './sessions.ts';
import { tokenMatches } from './token.ts';

type AppDeps = DocDeps & {
  db: Db;
  webDir: string;
  token: string;
  feed: ChangeFeed;
  /** The page's token for /api/launch, injected into index.html. */
  uiToken: string;
  /** Origins the hub's page is served from, e.g. http://127.0.0.1:4747. Their hosts are the only Host headers accepted. */
  origins: string[];
  launcher: Launcher;
  claudeDesktopInstalled: boolean;
  /** projects.yaml, as read and written by the hub page. */
  store: ProjectStore;
  /** How collectors' processes are found (lsof/ps on macOS; a fake in tests). */
  probe: ProcessProbe;
  /** For collectors' status endpoints; tests pass a fake. */
  fetcher?: typeof fetch;
  /** Called after a hook event is stored, e.g. to refresh that session's title. */
  onSessionActivity?: (sessionId: string, cwd: string, event: string) => void;
  /** Repo and GitHub status (Phase 5). */
  repos: RepoPoller;
  /** Where toolkit.yaml files are backed up before the hub first writes to them. */
  toolkitBackupDir: string;
  /** Recently changed files in project folders (Phase 6). */
  files: FileWatcher;
  /** Project folders must be inside it (default: your home folder). */
  home?: string;
  /** The Chrome extension's ID (Phase 7); /ext/* answers only it. */
  extensionId: string;
  /** The MCP server's read-only token (Phase 9); accepted on /agent/* only. */
  agentToken: string;
  /** Where review_queue.yaml is backed up before the hub first writes to it each run. */
  queueBackupDir: string;
};

/**
 * Why a request did not come from the hub's own page, or null if it did.
 * Browsers always send Origin on POST, PUT and DELETE and can't forge it; a
 * cross-site page also can't read index.html to learn the token, and JSON
 * forces a CORS preflight the hub never answers. (Same-origin GETs carry no
 * Origin, so for those the token and Sec-Fetch-Site do the work.)
 */
export function hubPageRefusal(c: Context, origins: string[], uiToken: string): string | null {
  const method = c.req.method;
  const origin = c.req.header('Origin');
  if (method === 'GET' ? origin !== undefined && !origins.includes(origin) : !origin || !origins.includes(origin)) {
    return 'requests must come from the hub page (Origin)';
  }
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin') return 'requests must come from the hub page (Sec-Fetch-Site)';
  // JSON (or, for the export import, a zip): types a plain form can't send, so
  // a cross-site page can't post here without a preflight the hub never answers.
  const type = c.req.header('Content-Type') ?? '';
  const zipOk = c.req.path === '/api/import/claude-export' && type.startsWith('application/zip');
  if ((method === 'POST' || method === 'PUT') && !type.startsWith('application/json') && !zipOk) {
    return 'requests must be JSON';
  }
  if (!tokenMatches(uiToken, c.req.header('X-Hub-Token'))) return 'bad or missing token';
  return null;
}

export function createApp(deps: AppDeps) {
  const { db, webDir, token, feed, uiToken, origins, launcher, claudeDesktopInstalled, store, probe, fetcher, onSessionActivity, repos, toolkitBackupDir, files } = deps;
  // toolkit.yaml files already backed up during this run.
  const toolkitBackedUp = new Set<string>();
  const projectRow = (slug: string) => db.select().from(projects).where(eq(projects.slug, slug)).get();
  // When Start was last clicked per project, to show "starting" until the port opens.
  const startClicked = new Map<string, number>();
  const app = new Hono();

  // Only answer requests addressed to the hub itself. This stops DNS rebinding:
  // a site that points its own name at 127.0.0.1 still sends its own Host.
  const hosts = new Set(origins.map((o) => new URL(o).host));
  app.use('*', async (c, next) => {
    if (!hosts.has(c.req.header('Host') ?? new URL(c.req.url).host)) return c.text('Wrong host', 421);
    await next();
  });

  // Every API call must come from the hub page with its token, except the
  // health check and the event stream (EventSource can't send headers, and
  // it carries no data, only "something changed").
  app.use('/api/*', async (c, next) => {
    const open = c.req.method === 'GET' && (c.req.path === '/api/health' || c.req.path === '/api/events');
    if (!open) {
      const refusal = hubPageRefusal(c, origins, uiToken);
      if (refusal) return c.json({ error: refusal }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  /** Every project, archived ones included (the page hides those), with its sessions. */
  app.get('/api/projects', (c) => {
    const projects = listAllProjects(db);
    const exists = (dir: string) => fs.existsSync(dir);
    // `resumeProblem` says why a session can't be reopened; null means it can.
    const all = sessionsForProjects(db, projects.map((p) => p.slug)).map((s) => ({ ...s, resumeProblem: resumeProblem(s, exists) }));
    const filedChats = db.select().from(chats).where(isNotNull(chats.projectSlug)).orderBy(desc(chats.lastActiveAt)).all();
    // `repoStatus` is one entry per repo in `repos`, null until its first check.
    return c.json(
      projects.map((p) => ({
        ...p,
        sessions: all.filter((s) => s.projectSlug === p.slug),
        chats: filedChats.filter((ch) => ch.projectSlug === p.slug),
        repoStatus: p.repos.map((dir) => repos.get(dir)),
        toolkit: toolkitSummary(p),
        applications: applicationsSummary(p),
      })),
    );
  });

  const activityInputs = (slugs?: string[]) => gatherActivity({ db, repos, files }, slugs);

  /** For the home page: each project's newest activity and whether it is stale. */
  app.get('/api/activity', (c) => {
    const out: Record<string, ProjectActivity> = {};
    for (const [slug, input] of activityInputs()) {
      const last = lastActivity(buildTimeline(input));
      out[slug] = { last, stale: isStale(last) };
    }
    return c.json(out);
  });

  /** One project's timeline, newest first; `?limit=` (default 30) and `total` for "Show older". */
  app.get('/api/projects/:slug/activity', (c) => {
    const slug = c.req.param('slug');
    const input = activityInputs([slug]).get(slug);
    if (!input) return c.json({ error: 'Unknown project' }, 404);
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 1000);
    const events = buildTimeline(input);
    return c.json({ events: events.slice(0, limit), total: events.length });
  });

  /** Whether projects.yaml currently parses. When it doesn't, the hub keeps the last good version. */
  app.get('/api/projects-file', (c) => c.json({ error: store.error() }));

  // Add, edit, archive and delete. Each one writes projects.yaml and reloads from it.
  const projectWrite = async (c: Context, run: () => unknown) => {
    try {
      return c.json({ ok: true, result: (await run()) ?? null });
    } catch (e) {
      if (e instanceof ProjectsFileError || e instanceof FolderError) return c.json({ error: e.message }, 400);
      throw e;
    }
  };
  const readInput = async (c: Context, slug?: string) => {
    const parsed = projectInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ProjectsFileError(parsed.error.issues.map((i) => i.message).join('; '));
    const before = slug ? listAllProjects(db).find((p) => p.slug === slug) : undefined;
    checkPaths(parsed.data.repos, 'repos', before?.repos ?? []);
    checkPaths(parsed.data.folders, 'folders', before?.folders ?? []);
    return parsed.data;
  };
  app.post('/api/projects', (c) => projectWrite(c, async () => store.add(await readInput(c))));
  app.put('/api/projects/:slug', (c) =>
    projectWrite(c, async () => store.update(c.req.param('slug'), await readInput(c, c.req.param('slug')))),
  );
  app.post('/api/projects/:slug/archive', (c) => projectWrite(c, () => store.setArchived(c.req.param('slug'), true)));
  app.post('/api/projects/:slug/unarchive', (c) => projectWrite(c, () => store.setArchived(c.req.param('slug'), false)));
  app.delete('/api/projects/:slug', (c) => projectWrite(c, () => ({ unfiledSessions: store.remove(c.req.param('slug')) })));

  addDocRoutes(app, deps);
  addLinkRoutes(app, deps);
  addChatRoutes(app, deps);
  addAgentRoutes(app, deps);
  addApplicationRoutes(app, deps);

  // The folder picker.
  app.get('/api/folders/suggestions', (c) => c.json(suggestions(db)));
  app.get('/api/folders/browse', (c) => {
    try {
      return c.json(browse(c.req.query('path') || undefined));
    } catch (e) {
      if (e instanceof FolderError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      // `data` names what changed ('files', or 'all'), so pages refetch only that.
      const send = (topic: string) => void stream.writeSSE({ event: 'change', data: topic });
      feed.on('change', send);
      stream.onAbort(() => {
        feed.off('change', send);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(25_000);
      }
    }),
  );

  app.post('/hooks/claude', async (c) => {
    if (!tokenMatches(token, c.req.header('X-Hub-Token'))) return c.json({ error: 'bad token' }, 401);
    const parsed = hookPayloadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad payload' }, 400);
    if (applyHookEvent(db, parsed.data, listAllProjects(db))) {
      feed.notify();
      onSessionActivity?.(parsed.data.session_id, parsed.data.cwd, parsed.data.hook_event_name);
      // Claude may have committed or pushed: check that repo now, not in 3 minutes.
      if (parsed.data.hook_event_name === 'Stop') for (const dir of repos.reposFor(parsed.data.cwd)) void repos.refresh(dir);
    }
    return c.body(null, 204);
  });

  app.post('/api/launch', async (c) => {
    const body = await c.req.json().catch(() => null);
    const collectorReq = collectorLaunchSchema.safeParse(body);
    const launchReq = launchRequestSchema.safeParse(body);
    const req = collectorReq.data ?? launchReq.data;
    if (!req) return c.json({ error: 'bad launch request' }, 400);
    try {
      let plan;
      if (collectorReq.data) {
        const { kind, slug, dryRun } = collectorReq.data;
        const p = projectRow(slug);
        if (!p) throw new LaunchError(404, `Unknown project ${slug}`);
        plan = kind === 'collector-start' ? await planCollectorStart(p, probe) : await planCollectorStop(p, probe);
        if (kind === 'collector-start' && !dryRun) startClicked.set(p.slug, Date.now());
      } else {
        plan = planLaunch(launchReq.data!, {
          session: (id) => db.select().from(sessions).where(eq(sessions.id, id)).get(),
          project: projectRow,
          claudeDesktopInstalled,
          exists: (p) => fs.existsSync(p),
          recentFile: (slug, file) => files.recent((f) => f === file && projectFileFilter(db, slug)(f), 1).length === 1,
          packetFile: (slug, id, which) => {
            const p = projectRow(slug);
            const [queue] = p ? findQueueFiles(p) : [];
            if (!queue) return { error: 'This project has no review queue' };
            const item = readQueue(queue).items.find((i) => i.id === id);
            if (!item) return { error: `"${id}" isn't in the review queue` };
            const f = findPacketFile(queueRoot(queue), item.packet, PACKET_FILES[which]);
            return f ? { path: f } : { error: `No ${PACKET_FILES[which]} inside ${item.packet ?? 'its packet folder'}` };
          },
        });
      }
      const command = describePlan(plan);
      if (req.dryRun) return c.json({ ok: true, dryRun: true, command });
      console.log(`${new Date().toISOString()} Launch ${req.kind}: ${command}`);
      await launcher(plan);
      return c.json({ ok: true, command });
    } catch (e) {
      if (e instanceof LaunchError) return c.json({ error: e.message }, e.status);
      console.error('Launch failed:', e instanceof Error ? e.message : e);
      return c.json({ error: `Launch failed: ${e instanceof Error ? e.message : e}` }, 500);
    }
  });

  /** The full checklist, read fresh from the project's toolkit.yaml. */
  app.get('/api/projects/:slug/toolkit', (c) => {
    const p = projectRow(c.req.param('slug'));
    const [file, ...others] = p ? findToolkitFiles(p) : [];
    if (!file) return c.json({ error: 'No toolkit.yaml for this project' }, 404);
    try {
      return c.json({ ...readToolkit(file), others });
    } catch (e) {
      if (e instanceof ToolkitError) return c.json({ file, error: e.message }, 200);
      throw e;
    }
  });

  /**
   * Sets one item's status in toolkit.yaml. The request names the item by
   * position and name and says which version of the file it saw; the path
   * comes from the project. A file changed since then is not overwritten:
   * the answer is 409 with the current checklist.
   */
  app.put('/api/projects/:slug/toolkit/items/:index', async (c) => {
    const p = projectRow(c.req.param('slug'));
    const [file] = p ? findToolkitFiles(p) : [];
    if (!file) return c.json({ error: 'No toolkit.yaml for this project' }, 404);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; status?: unknown; version?: unknown } | null;
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0 || typeof body?.name !== 'string' || typeof body.version !== 'string' || !STATUSES.includes(body.status as ToolkitStatus)) {
      return c.json({ error: `Send { name, version, status } with status one of: ${STATUSES.join(', ')}` }, 400);
    }
    try {
      const toolkit = writeToolkitStatus({
        file,
        version: body.version,
        index,
        name: body.name,
        status: body.status as ToolkitStatus,
        backupDir: toolkitBackupDir,
        backedUp: toolkitBackedUp,
      });
      console.log(`${new Date().toISOString()} Toolkit: ${p!.slug} "${body.name}" -> ${body.status}`);
      feed.notify();
      return c.json(toolkit);
    } catch (e) {
      if (!(e instanceof ToolkitError)) throw e;
      if (e.status !== 409) return c.json({ error: e.message }, e.status);
      let current = null;
      try {
        current = readToolkit(file);
      } catch {
        // The current file doesn't parse either; the page shows the error on reload.
      }
      return c.json({ error: e.message, current }, 409);
    }
  });

  /** Checks a project's repos now (the page's Refresh). Read-only for the repos. */
  app.post('/api/projects/:slug/repos/refresh', async (c) => {
    const p = projectRow(c.req.param('slug'));
    if (!p) return c.json({ error: 'Unknown project' }, 404);
    await Promise.all(p.repos.map((dir) => repos.refresh(dir)));
    return c.json({ ok: true, repoStatus: p.repos.map((dir) => repos.get(dir)) });
  });

  /** Whether a project's collector is running, and its sources' health. Read-only. */
  app.get('/api/projects/:slug/collector', async (c) => {
    const p = projectRow(c.req.param('slug'));
    if (!p?.collector) return c.json({ error: 'No collector for this project' }, 404);
    try {
      const proc = await findCollector(p.collector, collectorDir(p), probe);
      const clicked = startClicked.get(p.slug);
      const starting = proc.state === 'stopped' && clicked !== undefined && Date.now() - clicked < 60_000;
      if (proc.state === 'running') startClicked.delete(p.slug);
      const health = proc.state === 'running' ? await sourceHealth(p.collector.status_url, fetcher) : { sources: null, error: null };
      return c.json({ ...proc, ...(starting && { state: 'starting' }), port: p.collector.port, ...health });
    } catch (e) {
      if (e instanceof LaunchError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // The built UI. Run `pnpm build` first; in development Vite serves it instead.
  // index.html carries the launch token, so it is never cached or framed, and
  // it is only served from here (not by serveStatic).
  const indexHtml = path.join(webDir, 'index.html');
  const page = (c: Context) => {
    if (!fs.existsSync(indexHtml)) return c.text('UI not built yet. Run `pnpm build`, then reload.', 503);
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    return c.html(injectToken(fs.readFileSync(indexHtml, 'utf8'), uiToken));
  };
  app.get('/', page);
  app.get('/index.html', page);
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDir) }));
  app.get('*', page);

  return app;
}

/** For cards: "3 of 16 done" (parked items don't count), or why the file can't be read. */
/** "Applications: 2 drafts · 1 reviewed · 3 submitted" for a card, when the project has a review queue. */
function applicationsSummary(p: { repos: string[]; folders: string[] }) {
  const [file] = findQueueFiles(p);
  if (!file) return null;
  try {
    const q = readQueue(file);
    return { summary: queueSummary(q.counts), total: q.items.length, error: null };
  } catch (e) {
    return { summary: null, total: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export const injectToken = (html: string, uiToken: string) =>
  html.replace('</head>', `    <meta name="hub-token" content="${uiToken}" />\n  </head>`);

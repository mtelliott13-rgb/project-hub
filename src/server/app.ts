import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { listAllProjects, type Db } from './db/index.ts';
import { projects, sessions } from './db/schema.ts';
import { addDocRoutes, type DocDeps } from './doc-routes.ts';
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
  /** Called after a hook event is stored, e.g. to refresh that session's title. */
  onSessionActivity?: (sessionId: string, cwd: string) => void;
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
  if ((method === 'POST' || method === 'PUT') && !c.req.header('Content-Type')?.startsWith('application/json')) {
    return 'requests must be JSON';
  }
  if (!tokenMatches(uiToken, c.req.header('X-Hub-Token'))) return 'bad or missing token';
  return null;
}

export function createApp(deps: AppDeps) {
  const { db, webDir, token, feed, uiToken, origins, launcher, claudeDesktopInstalled, store, onSessionActivity } = deps;
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
    return c.json(projects.map((p) => ({ ...p, sessions: all.filter((s) => s.projectSlug === p.slug) })));
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
      const send = () => void stream.writeSSE({ event: 'change', data: '' });
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
      onSessionActivity?.(parsed.data.session_id, parsed.data.cwd);
    }
    return c.body(null, 204);
  });

  app.post('/api/launch', async (c) => {
    const parsed = launchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad launch request' }, 400);
    const req = parsed.data;
    try {
      const plan = planLaunch(req, {
        session: (id) => db.select().from(sessions).where(eq(sessions.id, id)).get(),
        project: (slug) => db.select().from(projects).where(eq(projects.slug, slug)).get(),
        claudeDesktopInstalled,
        exists: (p) => fs.existsSync(p),
      });
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

export const injectToken = (html: string, uiToken: string) =>
  html.replace('</head>', `    <meta name="hub-token" content="${uiToken}" />\n  </head>`);

import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { listActiveProjects, type Db } from './db/index.ts';
import { projects, sessions } from './db/schema.ts';
import type { ChangeFeed } from './events.ts';
import { describePlan, LaunchError, launchRequestSchema, planLaunch, type Launcher } from './launcher.ts';
import { applyHookEvent, hookPayloadSchema, sessionsForProjects } from './sessions.ts';
import { tokenMatches } from './token.ts';

type AppDeps = {
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
  /** Called after a hook event is stored, e.g. to refresh that session's title. */
  onSessionActivity?: (sessionId: string, cwd: string) => void;
};

/**
 * Why a launch request did not come from the hub's own page, or null if it did.
 * Browsers always send Origin on a POST and can't forge it; a cross-site page also
 * can't read index.html to learn the token, and JSON forces a CORS preflight the
 * hub never answers.
 */
export function launchRefusal(c: Context, origins: string[], uiToken: string): string | null {
  const origin = c.req.header('Origin');
  if (!origin || !origins.includes(origin)) return 'launch requests must come from the hub page (Origin)';
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin') return 'launch requests must come from the hub page (Sec-Fetch-Site)';
  if (!c.req.header('Content-Type')?.startsWith('application/json')) return 'launch requests must be JSON';
  if (!tokenMatches(uiToken, c.req.header('X-Hub-Token'))) return 'bad or missing token';
  return null;
}

export function createApp(deps: AppDeps) {
  const { db, webDir, token, feed, uiToken, origins, launcher, claudeDesktopInstalled, onSessionActivity } = deps;
  const app = new Hono();

  // Only answer requests addressed to the hub itself. This stops DNS rebinding:
  // a site that points its own name at 127.0.0.1 still sends its own Host.
  const hosts = new Set(origins.map((o) => new URL(o).host));
  app.use('*', async (c, next) => {
    if (!hosts.has(c.req.header('Host') ?? new URL(c.req.url).host)) return c.text('Wrong host', 421);
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/projects', (c) => {
    const projects = listActiveProjects(db);
    const all = sessionsForProjects(db, projects.map((p) => p.slug));
    return c.json(projects.map((p) => ({ ...p, sessions: all.filter((s) => s.projectSlug === p.slug) })));
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
    if (applyHookEvent(db, parsed.data, listActiveProjects(db))) {
      feed.notify();
      onSessionActivity?.(parsed.data.session_id, parsed.data.cwd);
    }
    return c.body(null, 204);
  });

  app.post('/api/launch', async (c) => {
    const refusal = launchRefusal(c, origins, uiToken);
    if (refusal) return c.json({ error: refusal }, 403);
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
      console.log(`Launch ${req.kind}: ${command}`);
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

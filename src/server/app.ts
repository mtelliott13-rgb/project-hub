import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { listActiveProjects, type Db } from './db/index.ts';
import type { ChangeFeed } from './events.ts';
import { applyHookEvent, hookPayloadSchema, sessionsForProjects } from './sessions.ts';
import { tokenMatches } from './token.ts';

type AppDeps = {
  db: Db;
  webDir: string;
  token: string;
  feed: ChangeFeed;
  /** Called after a hook event is stored, e.g. to refresh that session's title. */
  onSessionActivity?: (sessionId: string, cwd: string) => void;
};

export function createApp({ db, webDir, token, feed, onSessionActivity }: AppDeps) {
  const app = new Hono();

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

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // The built UI. Run `pnpm build` first; in development Vite serves it instead.
  const indexHtml = path.join(webDir, 'index.html');
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDir) }));
  app.get('*', (c) =>
    fs.existsSync(indexHtml)
      ? c.html(fs.readFileSync(indexHtml, 'utf8'))
      : c.text('UI not built yet. Run `pnpm build`, then reload.', 503),
  );

  return app;
}

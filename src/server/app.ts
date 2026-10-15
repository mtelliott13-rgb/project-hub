import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { listActiveProjects, type Db } from './db/index.ts';

export function createApp({ db, webDir }: { db: Db; webDir: string }) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/projects', (c) => c.json(listActiveProjects(db)));
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

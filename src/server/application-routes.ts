// Applications (Career HQ's review queue) for the hub page: read the queue,
// read one fill sheet, change one status. Every route is under /api, so it
// needs the page token, and writes go through hubPageRefusal like all others.
// Answers are sent no-store (they hold personal details). Not in /agent: the
// MCP tools never see any of this.
import type { Context, Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { projects } from './db/schema.ts';
import type { ChangeFeed } from './events.ts';
import { APP_STATUSES, findQueueFiles, QueueError, readFillSheet, readQueue, writeQueueStatus, type AppStatus } from './applications.ts';

export type ApplicationDeps = { db: Db; feed: ChangeFeed; queueBackupDir: string };

export function addApplicationRoutes(app: Hono, { db, feed, queueBackupDir }: ApplicationDeps) {
  const backedUp = new Set<string>();
  const queueFile = (slug: string) => {
    const p = db.select().from(projects).where(eq(projects.slug, slug)).get();
    return p ? { p, file: findQueueFiles(p)[0] } : { p: undefined, file: undefined };
  };
  const private_ = (c: Context) => c.header('Cache-Control', 'no-store');

  /** The whole queue, read fresh. A file that doesn't parse comes back as { file, error }. */
  app.get('/api/projects/:slug/applications', (c) => {
    private_(c);
    const { file } = queueFile(c.req.param('slug'));
    if (!file) return c.json({ error: 'No review queue for this project' }, 404);
    try {
      return c.json(readQueue(file));
    } catch (e) {
      if (e instanceof QueueError) return c.json({ file, error: e.message });
      throw e;
    }
  });

  /** One application's fill sheet, from its packet folder inside the repo. */
  app.get('/api/projects/:slug/applications/:id/fill-sheet', (c) => {
    private_(c);
    const { file } = queueFile(c.req.param('slug'));
    if (!file) return c.json({ error: 'No review queue for this project' }, 404);
    try {
      return c.json(readFillSheet(file, c.req.param('id')));
    } catch (e) {
      if (e instanceof QueueError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  /**
   * Sets one application's status. Names the item by position and id, with the
   * file version the page loaded; a changed file is not overwritten (409 with
   * the current queue).
   */
  app.put('/api/projects/:slug/applications/:index', async (c) => {
    private_(c);
    const { p, file } = queueFile(c.req.param('slug'));
    if (!file) return c.json({ error: 'No review queue for this project' }, 404);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; status?: unknown; version?: unknown } | null;
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0 || typeof body?.id !== 'string' || typeof body.version !== 'string' || !APP_STATUSES.includes(body.status as AppStatus)) {
      return c.json({ error: `Send { id, version, status } with status one of: ${APP_STATUSES.join(', ')}` }, 400);
    }
    try {
      const queue = writeQueueStatus({ file, version: body.version, index, id: body.id, status: body.status as AppStatus, backupDir: queueBackupDir, backedUp });
      console.log(`${new Date().toISOString()} Applications: ${p!.slug} ${body.id} -> ${body.status}`);
      feed.notify();
      return c.json(queue);
    } catch (e) {
      if (!(e instanceof QueueError)) throw e;
      if (e.status !== 409) return c.json({ error: e.message }, e.status);
      let current = null;
      try {
        current = readQueue(file);
      } catch {
        // Doesn't parse either; the page shows the error on reload.
      }
      return c.json({ error: e.message, current }, 409);
    }
  });
}

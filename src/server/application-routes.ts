// Applications (Career HQ's review queue) for the hub page: read the queue and
// one fill sheet. Every route is under /api, so it needs the page token.
// Status changes go through POST /api/launch (queue-status.ts), which runs
// Career HQ's own command; the hub never writes the queue.
// Answers are sent no-store (they hold personal details). Not in /agent: the
// MCP tools never see any of this.
import type { Context, Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { projects } from './db/schema.ts';
import { findQueueFiles, QueueError, readFillSheet, readQueue, withLimits } from './applications.ts';

export type ApplicationDeps = { db: Db };

export function addApplicationRoutes(app: Hono, { db }: ApplicationDeps) {
  const queueFile = (slug: string) => {
    const p = db.select().from(projects).where(eq(projects.slug, slug)).get();
    const [file, ...others] = p ? findQueueFiles(p) : [];
    return { file, others };
  };
  const private_ = (c: Context) => c.header('Cache-Control', 'no-store');

  /**
   * The whole queue, read fresh, plus `others`: queue files also found but not
   * shown (both jobs/queue.yaml and the older path; the newer one wins).
   * A file that doesn't parse comes back as { file, error }.
   */
  app.get('/api/projects/:slug/applications', (c) => {
    private_(c);
    const { file, others } = queueFile(c.req.param('slug'));
    if (!file) return c.json({ error: 'No review queue for this project' }, 404);
    try {
      return c.json({ ...withLimits(readQueue(file)), others });
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
}

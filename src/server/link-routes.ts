// API for Phase 6: recent files, links, link rules and the Inbox.
import fs from 'node:fs';
import os from 'node:os';
import { eq, isNull, desc } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { listAllProjects, type Db } from './db/index.ts';
import { projects, sessions } from './db/schema.ts';
import type { ChangeFeed } from './events.ts';
import type { FileWatcher } from './files.ts';
import { checkPaths, FolderError, tooBroad } from './folders.ts';
import { addLink, addRule, deleteLink, deleteRule, fileLink, inboxLinks, LinkError, listRules, projectLinks, ruleChoices } from './links.ts';
import { matchProject, worktreeParent } from './matching.ts';
import type { ProjectStore } from './project-store.ts';
import { ProjectsFileError } from './projects-file.ts';
import { resumeProblem } from './sessions.ts';

export type LinkDeps = {
  db: Db;
  feed: ChangeFeed;
  store: ProjectStore;
  files: FileWatcher;
  /** Project folders must be inside it; tests point it at their temp folder. */
  home?: string;
};

const linkInput = z.object({
  url: z.string().min(1).max(4000),
  title: z.string().max(500).nullish(),
  slug: z.string().min(1).nullish(),
});
const fileInput = z.object({ slug: z.string().min(1).nullable() });
const ruleInput = z.object({ slug: z.string().min(1), host: z.string().min(1).max(253), pathPrefix: z.string().max(500).default('') });
const sessionFileInput = z.object({ slug: z.string().min(1), always: z.boolean().default(false) });

/** The files of one project: under its repos and folders, and not under a more specific project's. */
export const projectFileFilter = (db: Db, slug: string) => {
  const all = listAllProjects(db);
  return (file: string) => matchProject(file, all) === slug;
};

export function addLinkRoutes(app: Hono, { db, feed, store, files, home = os.homedir() }: LinkDeps) {
  const project = (slug: string) => db.select().from(projects).where(eq(projects.slug, slug)).get();
  const id = (c: Context) => Number(c.req.param('id'));
  const fail = (c: Context, e: unknown) => {
    if (e instanceof LinkError) return c.json({ error: e.message }, e.status);
    if (e instanceof ProjectsFileError || e instanceof FolderError) return c.json({ error: e.message }, 400);
    throw e;
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new LinkError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return parsed.data;
  };
  /** Rule choices for a link, for "always file these here". */
  const withChoices = <L extends { url: string }>(l: L) => ({ ...l, ...ruleChoices(l.url) });

  /** Recently changed files in the project's repos and folders, newest first. */
  app.get('/api/projects/:slug/files', (c) => {
    const p = project(c.req.param('slug'));
    if (!p) return c.json({ error: 'Unknown project' }, 404);
    const roots = [...p.repos, ...p.folders];
    return c.json({
      files: files.recent(projectFileFilter(db, p.slug), 50),
      watching: files.status().filter((s) => roots.includes(s.dir)),
      missing: roots.filter((d) => !fs.existsSync(d)),
    });
  });

  app.get('/api/projects/:slug/links', (c) => {
    const p = project(c.req.param('slug'));
    return p ? c.json(projectLinks(db, p.slug)) : c.json({ error: 'Unknown project' }, 404);
  });

  /** Everything waiting to be filed: links no rule matched, and sessions no folder matched. */
  app.get('/api/inbox', (c) => {
    const exists = (dir: string) => fs.existsSync(dir);
    const unfiled = db.select().from(sessions).where(isNull(sessions.projectSlug)).orderBy(desc(sessions.lastActiveAt)).all();
    return c.json({
      links: inboxLinks(db).map(withChoices),
      sessions: unfiled.map((s) => ({ ...s, resumeProblem: resumeProblem(s, exists), folder: worktreeParent(s.cwd), folderProblem: tooBroad(worktreeParent(s.cwd), home) })),
    });
  });

  /** Saves a link: filed into `slug` when given, else by the rules, else into the Inbox. */
  app.post('/api/links', async (c) => {
    try {
      const input = await body(c, linkInput);
      const out = addLink(db, listAllProjects(db), { ...input, source: 'paste' });
      feed.notify();
      return c.json({ ...out, link: withChoices(out.link) });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Files a link into a project by hand, or (slug null) puts it back in the Inbox. */
  app.put('/api/links/:id', async (c) => {
    try {
      const { slug } = await body(c, fileInput);
      if (slug && !project(slug)) throw new LinkError(404, `Unknown project ${slug}`);
      const link = fileLink(db, id(c), slug);
      feed.notify();
      return c.json({ link: withChoices(link) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/links/:id', (c) => {
    try {
      deleteLink(db, id(c));
      feed.notify();
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/link-rules', (c) => c.json(listRules(db)));

  /** "Always file these here": saves the rule and files the Inbox links it matches. */
  app.post('/api/link-rules', async (c) => {
    try {
      const out = addRule(db, listAllProjects(db), await body(c, ruleInput));
      feed.notify();
      return c.json(out);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/link-rules/:id', (c) => {
    try {
      deleteRule(db, id(c));
      feed.notify();
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  /**
   * Files an unfiled session. It is pinned to the project in projects.yaml
   * (`sessions:`); with `always`, its folder is added to the project instead,
   * so later sessions there file themselves. Too-broad folders are refused.
   */
  app.post('/api/inbox/sessions/:id/file', async (c) => {
    try {
      const { slug, always } = await body(c, sessionFileInput);
      const s = db.select().from(sessions).where(eq(sessions.id, c.req.param('id'))).get();
      if (!s) throw new LinkError(404, 'Unknown session');
      const p = project(slug);
      if (!p) throw new LinkError(404, `Unknown project ${slug}`);
      if (always) {
        const folder = worktreeParent(s.cwd);
        const broad = tooBroad(folder, home);
        if (broad) throw new LinkError(400, `${broad}. File just this session instead.`);
        checkPaths([folder], 'folders', [...p.folders, ...p.repos], home);
        store.addFolder(slug, folder);
      } else {
        store.pinSession(slug, s.id);
      }
      feed.notify();
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
}

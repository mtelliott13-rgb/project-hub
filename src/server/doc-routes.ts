// API for project pages (SPEC.md, Phase 4): notes, Monetize drafts, Generate, Ideas.
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from './db/index.ts';
import { projects, type Project } from './db/schema.ts';
import type { ProjectDocs } from './docs.ts';
import { addIdea, editIdea, IdeasError, parseIdeas } from './ideas.ts';
import { shellQuote } from './launcher.ts';
import { monetizeCommand, type MonetizeCommand, type MonetizeJobs } from './monetize.ts';

export type DocDeps = {
  db: Db;
  docs: ProjectDocs;
  ideasFile: string;
  jobs: MonetizeJobs;
};

/** The Generate command for a project, as it will run. */
export const generateCommand = (docs: ProjectDocs, p: Project): MonetizeCommand =>
  monetizeCommand(p, (d) => fs.existsSync(d), docs.dir(p.slug));

export const describeCommand = (cmd: MonetizeCommand) => `cd ${shellQuote(cmd.cwd)} && ${cmd.argv.map(shellQuote).join(' ')}`;

const textBody = z.object({ text: z.string().max(200_000) });

export function addDocRoutes(app: Hono, { db, docs, ideasFile, jobs }: DocDeps) {
  const project = (slug: string) => db.select().from(projects).where(eq(projects.slug, slug)).get();

  app.get('/api/projects/:slug/notes', (c) => {
    const p = project(c.req.param('slug'));
    return p ? c.json(docs.notes(p.slug)) : c.json({ error: 'Unknown project' }, 404);
  });

  app.put('/api/projects/:slug/notes', async (c) => {
    const p = project(c.req.param('slug'));
    if (!p) return c.json({ error: 'Unknown project' }, 404);
    const body = textBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send { text }' }, 400);
    return c.json(docs.saveNotes(p.slug, body.data.text));
  });

  app.get('/api/projects/:slug/monetize', (c) => {
    const p = project(c.req.param('slug'));
    if (!p) return c.json({ error: 'Unknown project' }, 404);
    return c.json({ drafts: docs.drafts(p.slug), job: jobs.get(p.slug), command: describeCommand(generateCommand(docs, p)) });
  });

  app.get('/api/projects/:slug/monetize/:id', (c) => {
    const p = project(c.req.param('slug'));
    const d = p && /^[\dT-]+Z$/.test(c.req.param('id')) ? docs.draft(p.slug, c.req.param('id')) : null;
    return d ? c.json(d) : c.json({ error: 'No such draft' }, 404);
  });

  app.put('/api/projects/:slug/monetize/:id', async (c) => {
    const p = project(c.req.param('slug'));
    const id = c.req.param('id');
    if (!p || !/^[\dT-]+Z$/.test(id) || !docs.draft(p.slug, id)) return c.json({ error: 'No such draft' }, 404);
    const body = textBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Send { text }' }, 400);
    return c.json(docs.editDraft(p.slug, id, body.data.text));
  });

  app.post('/api/projects/:slug/monetize/generate', (c) => {
    const p = project(c.req.param('slug'));
    if (!p) return c.json({ error: 'Unknown project' }, 404);
    if (!jobs.start(p.slug)) return c.json({ error: 'Already generating a draft for this project' }, 409);
    console.log(`${new Date().toISOString()} Generate monetize draft for ${p.slug}`);
    return c.json({ ok: true }, 202);
  });

  // Ideas
  const readIdeas = () => (fs.existsSync(ideasFile) ? fs.readFileSync(ideasFile, 'utf8') : '');
  const writeIdeas = (text: string) => {
    fs.mkdirSync(path.dirname(ideasFile), { recursive: true });
    fs.writeFileSync(`${ideasFile}.tmp`, text);
    fs.renameSync(`${ideasFile}.tmp`, ideasFile);
  };
  const scopeOk = (scope: string) => scope === 'hub' || project(scope) !== undefined;
  const ideasCall = async (c: Context, run: () => Promise<unknown> | unknown) => {
    try {
      await run();
      return c.json({ items: parseIdeas(readIdeas()) });
    } catch (e) {
      if (e instanceof IdeasError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };

  app.get('/api/ideas', (c) => c.json({ items: parseIdeas(readIdeas()), file: ideasFile }));

  const newIdea = z.object({ text: z.string(), scope: z.string().default('hub') });
  app.post('/api/ideas', (c) =>
    ideasCall(c, async () => {
      const body = newIdea.safeParse(await c.req.json().catch(() => null));
      if (!body.success) throw new IdeasError(400, 'Send { text, scope }');
      if (!scopeOk(body.data.scope)) throw new IdeasError(400, `Unknown project ${body.data.scope}`);
      writeIdeas(addIdea(readIdeas(), body.data));
    }),
  );

  const change = z.object({
    expect: z.string(),
    text: z.string().optional(),
    scope: z.string().optional(),
    done: z.boolean().optional(),
  });
  app.put('/api/ideas/:line', (c) =>
    ideasCall(c, async () => {
      const body = change.safeParse(await c.req.json().catch(() => null));
      if (!body.success) throw new IdeasError(400, 'Send { expect, text?, scope?, done? }');
      const { expect, ...rest } = body.data;
      if (rest.scope !== undefined && !scopeOk(rest.scope)) throw new IdeasError(400, `Unknown project ${rest.scope}`);
      writeIdeas(editIdea(readIdeas(), Number(c.req.param('line')), expect, rest));
    }),
  );

  app.delete('/api/ideas/:line', (c) =>
    ideasCall(c, async () => {
      const body = z.object({ expect: z.string() }).safeParse(await c.req.json().catch(() => null));
      if (!body.success) throw new IdeasError(400, 'Send { expect }');
      writeIdeas(editIdea(readIdeas(), Number(c.req.param('line')), body.data.expect, 'delete'));
    }),
  );
}


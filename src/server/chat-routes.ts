// API for Phase 7: the Chrome extension's /ext/* routes, and the page's chats,
// Claude Project mappings and data-export import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  ChatError,
  chatSightingSchema,
  claudeProjectList,
  fileChat,
  importExport,
  mapClaudeProject,
  projectChats,
  recordChat,
  uuid,
} from './chats.ts';
import { listAllProjects, type Db } from './db/index.ts';
import { chats, linkRules } from './db/schema.ts';
import type { ChangeFeed } from './events.ts';
import { addLink, LinkError, matchLink, parseLink } from './links.ts';

export type ChatDeps = {
  db: Db;
  feed: ChangeFeed;
  /** The extension's Chrome ID; /ext/* answers only requests from it. */
  extensionId: string;
};

const CHAT_URL = /^https:\/\/claude\.ai\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/i;
// A claude.ai export is a few hundred MB at most; refuse anything absurd.
const MAX_IMPORT_BYTES = 2 * 1024 ** 3;

/**
 * Why a request did not come from the extension, or null if it did. Only the
 * extension's own pages and worker can send Origin chrome-extension://<its id>;
 * web pages and other extensions can't. Every /ext/* call is a JSON POST.
 */
export function extensionRefusal(c: Context, extensionId: string): string | null {
  if (c.req.method !== 'POST') return 'extension calls are POSTs';
  if (c.req.header('Origin') !== `chrome-extension://${extensionId}`) return 'requests must come from the Project Hub extension (Origin)';
  if (!c.req.header('Content-Type')?.startsWith('application/json')) return 'requests must be JSON';
  return null;
}

export function addChatRoutes(app: Hono, { db, feed, extensionId }: ChatDeps) {
  /** When the extension last reported a chat, for the settings page. */
  let lastHeard: { at: string; chatId: string } | null = null;

  const fail = (c: Context, e: unknown) => {
    if (e instanceof ChatError || e instanceof LinkError) return c.json({ error: e.message }, e.status);
    throw e;
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ChatError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return parsed.data;
  };
  const projectName = (slug: string | null) => (slug ? (listAllProjects(db).find((p) => p.slug === slug)?.name ?? slug) : null);

  app.use('/ext/*', async (c, next) => {
    const refusal = extensionRefusal(c, extensionId);
    if (refusal) return c.json({ error: refusal }, 403);
    await next();
  });

  /** The extension: a chat is open in Chrome (sent on open, and again when its title or project changes). */
  app.post('/ext/chat', async (c) => {
    try {
      const sighting = await body(c, chatSightingSchema);
      const chat = recordChat(db, listAllProjects(db), sighting);
      lastHeard = { at: new Date().toISOString(), chatId: chat.id };
      feed.notify();
      return c.json({ projectSlug: chat.projectSlug, projectName: projectName(chat.projectSlug), filedBy: chat.filedBy });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** The popup: what this tab is, the projects to choose from, and the likely one. */
  app.post('/ext/tab', async (c) => {
    try {
      const { url } = await body(c, z.object({ url: z.string().min(1).max(4000) }));
      const active = listAllProjects(db).filter((p) => !p.archived);
      const projects = active.map((p) => ({ slug: p.slug, name: p.name }));
      const chatId = url.match(CHAT_URL)?.[1].toLowerCase();
      if (chatId) {
        const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
        return c.json({ kind: 'chat', chatId, projects, suggested: chat?.projectSlug ?? null, current: chat ? (projectName(chat.projectSlug) ?? 'the Inbox') : null });
      }
      const match = matchLink(parseLink(url), active, db.select().from(linkRules).all());
      return c.json({ kind: 'link', projects, suggested: match?.slug ?? null, current: null });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** The popup's Add on a web page: saves it as a link (filed into `slug`, or by the rules). */
  app.post('/ext/link', async (c) => {
    try {
      const input = await body(c, z.object({ url: z.string().min(1).max(4000), title: z.string().max(500).nullish(), slug: z.string().min(1).nullish() }));
      const { link } = addLink(db, listAllProjects(db), { ...input, source: 'extension' });
      feed.notify();
      return c.json({ projectSlug: link.projectSlug, projectName: projectName(link.projectSlug) });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** The popup's Add on a claude.ai chat: files the chat by hand (or back to automatic with null). */
  app.post('/ext/chat/file', async (c) => {
    try {
      const { chatId, title, slug } = await body(c, z.object({ chatId: uuid, title: z.string().max(500).nullish(), slug: z.string().min(1).nullable() }));
      const all = listAllProjects(db);
      if (!db.select().from(chats).where(eq(chats.id, chatId)).get()) {
        recordChat(db, all, { chatId, title: title?.replace(/\s+[-–—|]\s+Claude\s*$/, '').trim() || null, projectId: null });
      }
      let chat = fileChat(db, all, chatId, slug);
      if (!slug) chat = recordChat(db, all, { chatId, title: null, projectId: null });
      feed.notify();
      return c.json({ projectSlug: chat.projectSlug, projectName: projectName(chat.projectSlug) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // The hub page (these go through hubPageRefusal like every /api/* call).

  app.get('/api/projects/:slug/chats', (c) => c.json(projectChats(db, c.req.param('slug'))));

  /** Files a chat by hand, or (slug null) back to the Inbox, where its Claude Project and keywords apply again. */
  app.put('/api/chats/:id', async (c) => {
    try {
      const { slug } = await body(c, z.object({ slug: z.string().min(1).nullable() }));
      const all = listAllProjects(db);
      let chat = fileChat(db, all, c.req.param('id').toLowerCase(), slug);
      if (!slug) chat = recordChat(db, all, { chatId: chat.id, title: null, projectId: null }, chat.lastActiveAt);
      feed.notify();
      return c.json({ chat });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Claude Projects the hub has seen, where each maps, and whether the extension has been heard from. */
  app.get('/api/claude-projects', (c) =>
    c.json({ claudeProjects: claudeProjectList(db, listAllProjects(db)), extension: { id: extensionId, lastHeard } }),
  );

  /** Maps a Claude Project to a hub project (null unmaps it); its chats re-file at once. */
  app.put('/api/claude-projects/:id', async (c) => {
    try {
      const id = uuid.parse(c.req.param('id'));
      const { slug } = await body(c, z.object({ slug: z.string().min(1).nullable() }));
      const moved = mapClaudeProject(db, listAllProjects(db), id, slug);
      feed.notify();
      return c.json({ ok: true, moved });
    } catch (e) {
      if (e instanceof z.ZodError) return c.json({ error: 'Claude Project ids are UUIDs' }, 400);
      return fail(c, e);
    }
  });

  /**
   * Imports the claude.ai data export: the .zip as downloaded, or its
   * conversations.json alone. The upload goes to a private temp folder that is
   * deleted afterwards; only chat ids, titles, dates and Claude Projects are kept.
   */
  app.post('/api/import/claude-export', async (c) => {
    const type = c.req.header('Content-Type') ?? '';
    const isZip = type.startsWith('application/zip');
    if (!c.req.raw.body) return c.json({ error: 'No file' }, 400);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-import-'));
    try {
      const file = path.join(tmp, isZip ? 'export.zip' : 'conversations.json');
      let bytes = 0;
      const counted = Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_IMPORT_BYTES) counted.destroy(new ChatError(400, 'That file is too big to be a claude.ai export'));
      });
      await pipeline(counted, fs.createWriteStream(file, { mode: 0o600 }));
      let conversations: unknown;
      let projectsJson: unknown = null;
      if (isZip) {
        const listing = await execa('/usr/bin/unzip', ['-Z1', file], { reject: false });
        if (listing.exitCode !== 0) throw new ChatError(400, "That file isn't a zip. Upload the export as downloaded, or its conversations.json.");
        const names = listing.stdout.split('\n');
        const find = (name: string) => names.filter((n) => n === name || n.endsWith(`/${name}`)).sort((a, b) => a.length - b.length)[0];
        const conv = find('conversations.json');
        if (!conv) throw new ChatError(400, 'No conversations.json in that zip. Is it the export from claude.ai Settings > Privacy?');
        const read = async (entry: string) => JSON.parse((await execa('/usr/bin/unzip', ['-p', file, entry], { maxBuffer: MAX_IMPORT_BYTES, encoding: 'utf8' })).stdout);
        conversations = await read(conv);
        const proj = find('projects.json');
        if (proj) projectsJson = await read(proj);
      } else {
        conversations = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      const result = importExport(db, listAllProjects(db), conversations, projectsJson);
      console.log(`${new Date().toISOString()} Imported claude.ai export: ${result.chats} chats (${result.added} new), ${result.filed} filed, ${result.inbox} in the Inbox`);
      feed.notify();
      return c.json(result);
    } catch (e) {
      if (e instanceof SyntaxError) return c.json({ error: `That file isn't valid JSON: ${e.message}` }, 400);
      if (e instanceof ChatError) return c.json({ error: e.message }, e.status);
      throw e;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

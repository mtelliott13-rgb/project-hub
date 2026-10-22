// claude.ai chats (SPEC.md, Phase 7). The hub keeps a chat's id, title and
// Claude Project, never its messages. A chat files into the hub project its
// Claude Project is mapped to, else the project whose keyword is in its title,
// else the Inbox. Chats filed by hand stay where you put them.
import { desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/index.ts';
import { chats, claudeProjects, type Chat, type ClaudeProject, type Project } from './db/schema.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class ChatError extends Error {
  status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuid = z.string().regex(UUID, 'must be a UUID').transform((s) => s.toLowerCase());

/** The Claude Project id in a projects.yaml `claude_project` link. */
export const claudeProjectIdOf = (link: string | null | undefined) => link?.match(/\/project\/([0-9a-f-]{36})/i)?.[1].toLowerCase() ?? null;

/** What the extension sends: nothing but these three fields is read. */
export const chatSightingSchema = z.object({
  chatId: uuid,
  title: z.string().trim().max(500).nullish().transform((t) => t || null),
  projectId: uuid.nullish().transform((p) => p ?? null),
});
export type ChatSighting = z.infer<typeof chatSightingSchema>;

type Matchable = Pick<Project, 'slug' | 'keywords' | 'claudeProject' | 'archived'>;
export type ChatMatch = { slug: string; filedBy: 'claude-project' | 'keyword' };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Its Claude Project's hub project (a mapping from the settings page wins over
 * projects.yaml), else the active project with the longest keyword found as
 * whole words in the title. Two projects tying on keyword length is too
 * close to call, so that goes to the Inbox.
 */
export function matchChat(chat: Pick<Chat, 'title' | 'claudeProjectId'>, projects: Matchable[], mappings: Pick<ClaudeProject, 'id' | 'projectSlug'>[]): ChatMatch | null {
  if (chat.claudeProjectId) {
    const mapped = mappings.find((m) => m.id === chat.claudeProjectId)?.projectSlug;
    if (mapped && projects.some((p) => p.slug === mapped)) return { slug: mapped, filedBy: 'claude-project' };
    const fromYaml = projects.find((p) => claudeProjectIdOf(p.claudeProject) === chat.claudeProjectId);
    if (fromYaml) return { slug: fromYaml.slug, filedBy: 'claude-project' };
  }
  if (!chat.title) return null;
  let best: { slug: string; length: number; tied: boolean } | null = null;
  for (const p of projects) {
    if (p.archived) continue;
    for (const k of p.keywords) {
      if (!new RegExp(`(^|[^\\p{L}\\p{N}])${escape(k)}($|[^\\p{L}\\p{N}])`, 'iu').test(chat.title)) continue;
      if (!best || k.length > best.length) best = { slug: p.slug, length: k.length, tied: false };
      else if (k.length === best.length && best.slug !== p.slug) best.tied = true;
    }
  }
  return best && !best.tied ? { slug: best.slug, filedBy: 'keyword' } : null;
}

const mappingsOf = (db: Db | Tx) => db.select().from(claudeProjects).all();

/** Re-files every chat not filed by hand, e.g. after projects.yaml or a mapping changes. Returns how many moved. */
export function refileChats(db: Db, projects: Matchable[]): number {
  const mappings = mappingsOf(db);
  let moved = 0;
  db.transaction((tx) => {
    for (const c of tx.select().from(chats).where(or(isNull(chats.filedBy), ne(chats.filedBy, 'manual'))).all()) {
      const m = matchChat(c, projects, mappings);
      if ((m?.slug ?? null) === c.projectSlug && (m?.filedBy ?? null) === c.filedBy) continue;
      tx.update(chats).set({ projectSlug: m?.slug ?? null, filedBy: m?.filedBy ?? null }).where(eq(chats.id, c.id)).run();
      moved++;
    }
  });
  return moved;
}

/** Remembers a Claude Project id (unmapped) so the settings page can list it. */
function seeClaudeProject(db: Db | Tx, id: string, name: string | null, now: Date) {
  db.insert(claudeProjects)
    .values({ id, name, projectSlug: null, updatedAt: now })
    .onConflictDoUpdate({ target: claudeProjects.id, set: name ? { name, updatedAt: now } : { updatedAt: now } })
    .run();
}

/**
 * A chat open in Chrome (the extension). Saves its title and Claude Project,
 * marks it active now, and files it unless it was filed by hand.
 */
export function recordChat(db: Db, projects: Matchable[], s: ChatSighting, now = new Date()): Chat {
  db.transaction((tx) => {
    if (s.projectId) seeClaudeProject(tx, s.projectId, null, now);
    const old = tx.select().from(chats).where(eq(chats.id, s.chatId)).get();
    const next = {
      title: s.title ?? old?.title ?? null,
      // The page shows no project link while it loads; keep what we knew.
      claudeProjectId: s.projectId ?? old?.claudeProjectId ?? null,
    };
    const m = old?.filedBy === 'manual' ? null : matchChat(next, projects, mappingsOf(tx));
    const filing = old?.filedBy === 'manual' ? {} : { projectSlug: m?.slug ?? null, filedBy: m?.filedBy ?? null };
    tx.insert(chats)
      .values({ id: s.chatId, ...next, ...filing, source: 'extension', createdAt: now, lastActiveAt: now })
      .onConflictDoUpdate({ target: chats.id, set: { ...next, ...filing, lastActiveAt: now } })
      .run();
  });
  return db.select().from(chats).where(eq(chats.id, s.chatId)).get()!;
}

/** Files a chat by hand, or puts it back in the Inbox (slug null), where the rules apply again. */
export function fileChat(db: Db, projects: Matchable[], id: string, slug: string | null) {
  const c = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!c) throw new ChatError(404, 'Unknown chat');
  if (slug && !projects.some((p) => p.slug === slug)) throw new ChatError(404, `Unknown project ${slug}`);
  db.update(chats).set(slug ? { projectSlug: slug, filedBy: 'manual' } : { projectSlug: null, filedBy: null }).where(eq(chats.id, id)).run();
  return db.select().from(chats).where(eq(chats.id, id)).get()!;
}

/** Maps a Claude Project to a hub project (or unmaps it with null), then re-files. */
export function mapClaudeProject(db: Db, projects: Matchable[], id: string, slug: string | null, now = new Date()) {
  if (slug && !projects.some((p) => p.slug === slug)) throw new ChatError(404, `Unknown project ${slug}`);
  db.insert(claudeProjects)
    .values({ id, name: null, projectSlug: slug, updatedAt: now })
    .onConflictDoUpdate({ target: claudeProjects.id, set: { projectSlug: slug, updatedAt: now } })
    .run();
  return refileChats(db, projects);
}

export const inboxChats = (db: Db) => db.select().from(chats).where(isNull(chats.projectSlug)).orderBy(desc(chats.lastActiveAt)).all();
export const projectChats = (db: Db, slug: string) => db.select().from(chats).where(eq(chats.projectSlug, slug)).orderBy(desc(chats.lastActiveAt)).all();

/**
 * Every Claude Project the hub knows, with its chat count and where it maps:
 * from this table, else from projects.yaml (`yaml: true`, changed there).
 */
export function claudeProjectList(db: Db, projects: Pick<Project, 'slug' | 'claudeProject'>[]) {
  const rows = new Map(mappingsOf(db).map((r) => [r.id, r]));
  for (const p of projects) {
    const id = claudeProjectIdOf(p.claudeProject);
    if (id && !rows.has(id)) rows.set(id, { id, name: null, projectSlug: null, updatedAt: new Date(0) });
  }
  const counts = new Map<string, number>();
  for (const c of db.select({ id: chats.claudeProjectId }).from(chats).all()) if (c.id) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  return [...rows.values()]
    .map((r) => {
      const yaml = projects.find((p) => claudeProjectIdOf(p.claudeProject) === r.id)?.slug ?? null;
      return { id: r.id, name: r.name, projectSlug: r.projectSlug, yamlSlug: yaml, chats: counts.get(r.id) ?? 0 };
    })
    .sort((a, b) => (a.name ?? '~').localeCompare(b.name ?? '~') || b.chats - a.chats);
}

/** For a deleted project: its chats go back to the Inbox and its mappings are cleared. */
export function releaseProjectChats(db: Db | Tx, slug: string) {
  db.update(chats).set({ projectSlug: null, filedBy: null }).where(eq(chats.projectSlug, slug)).run();
  db.update(claudeProjects).set({ projectSlug: null }).where(eq(claudeProjects.projectSlug, slug)).run();
}

// The claude.ai data export (Settings > Privacy > Export data): a zip with
// conversations.json and projects.json. Only ids, names, dates and the Claude
// Project are read; message text is parsed past and never kept.
const exportChat = z.object({
  uuid: uuid,
  name: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  project_uuid: uuid.nullish(),
  project: z.object({ uuid: uuid }).nullish(),
});
const exportProject = z.object({ uuid: uuid, name: z.string().nullish() });

const date = (s: string | null | undefined, fallback: Date) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
};

export type ImportResult = { chats: number; added: number; claudeProjects: number; skipped: number; filed: number; inbox: number };

/**
 * Adds chats from the export's conversations.json (and Claude Project names
 * from projects.json). A chat the hub already has keeps its title and Claude
 * Project unless the hub had none; its last activity becomes the later of the two.
 */
export function importExport(db: Db, projects: Matchable[], conversations: unknown, projectsJson: unknown, now = new Date()): ImportResult {
  if (!Array.isArray(conversations)) throw new ChatError(400, "This doesn't look like a claude.ai export: conversations.json should be a list");
  const res: ImportResult = { chats: 0, added: 0, claudeProjects: 0, skipped: 0, filed: 0, inbox: 0 };
  const ids: string[] = [];
  db.transaction((tx) => {
    for (const raw of Array.isArray(projectsJson) ? projectsJson : []) {
      const p = exportProject.safeParse(raw);
      if (!p.success) continue;
      seeClaudeProject(tx, p.data.uuid, p.data.name?.trim() || null, now);
      res.claudeProjects++;
    }
    for (const raw of conversations) {
      const c = exportChat.safeParse(raw);
      if (!c.success) {
        res.skipped++;
        continue;
      }
      const projectId = c.data.project_uuid ?? c.data.project?.uuid ?? null;
      if (projectId) seeClaudeProject(tx, projectId, null, now);
      const created = date(c.data.created_at, now);
      const updated = date(c.data.updated_at, created);
      const old = tx.select().from(chats).where(eq(chats.id, c.data.uuid)).get();
      if (old) {
        tx.update(chats)
          .set({
            title: old.title ?? (c.data.name?.trim() || null),
            claudeProjectId: old.claudeProjectId ?? projectId,
            createdAt: created < old.createdAt ? created : old.createdAt,
            lastActiveAt: updated > old.lastActiveAt ? updated : old.lastActiveAt,
          })
          .where(eq(chats.id, old.id))
          .run();
      } else {
        tx.insert(chats)
          .values({ id: c.data.uuid, title: c.data.name?.trim() || null, claudeProjectId: projectId, source: 'export', createdAt: created, lastActiveAt: updated })
          .run();
        res.added++;
      }
      ids.push(c.data.uuid);
      res.chats++;
    }
  });
  refileChats(db, projects);
  // Where the imported chats landed (in chunks: SQLite caps query parameters).
  for (let i = 0; i < ids.length; i += 500) {
    for (const c of db.select({ slug: chats.projectSlug }).from(chats).where(inArray(chats.id, ids.slice(i, i + 500))).all()) {
      if (c.slug) res.filed++;
      else res.inbox++;
    }
  }
  return res;
}

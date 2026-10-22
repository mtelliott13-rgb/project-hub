// Docs and web links (SPEC.md, Phase 6). A link files itself by the most
// specific match: a saved rule (domain, or domain plus path), or the project's
// own GitHub repo or Claude Project from projects.yaml. Anything else waits in
// the Inbox, where filing it can save a rule so the next similar link files
// itself.
import { desc, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { linkRules, links, type Link, type LinkRule, type Project } from './db/schema.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class LinkError extends Error {
  status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

export type ParsedUrl = { url: string; key: string; host: string; path: string };

/** Accepts http/https only. `path` is lowercased with no trailing slash ('' for the root). */
export function parseLink(raw: string): ParsedUrl {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new LinkError(400, `Not a link: ${raw.trim().slice(0, 200)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LinkError(400, 'Only http and https links can be saved');
  const host = normHost(u.hostname);
  const path = normPath(u.pathname);
  // The key ignores the #fragment (a heading in the same doc) and the scheme.
  return { url: u.href, key: `${host}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}${u.search}`, host, path };
}

export const normHost = (h: string) => h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
export const normPath = (p: string) => {
  const s = p.toLowerCase().replace(/\/+$/, '');
  return s === '' || s.startsWith('/') ? s : `/${s}`;
};

const hostMatches = (host: string, ruleHost: string) => host === ruleHost || host.endsWith(`.${ruleHost}`);
const pathMatches = (path: string, prefix: string) => prefix === '' || path === prefix || path.startsWith(`${prefix}/`);

export type Match = { slug: string; filedBy: 'rule' | 'github' | 'claude-project'; ruleId: number | null };

type Candidate = Match & { host: string; pathPrefix: string; createdAt: number };

/** The project's own entries as rules: github.com/<owner>/<repo> and claude.ai/project/<id>. */
function builtIns(projects: Pick<Project, 'slug' | 'github' | 'claudeProject'>[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of projects) {
    for (const repo of p.github) out.push({ slug: p.slug, filedBy: 'github', ruleId: null, host: 'github.com', pathPrefix: `/${repo.toLowerCase()}`, createdAt: 0 });
    const id = p.claudeProject?.match(/\/project\/([0-9a-f-]{36})/i)?.[1];
    if (id) out.push({ slug: p.slug, filedBy: 'claude-project', ruleId: null, host: 'claude.ai', pathPrefix: `/project/${id.toLowerCase()}`, createdAt: 0 });
  }
  return out;
}

/**
 * The project a link files into, or null for the Inbox. The most specific
 * match wins: the exact host over a parent domain, then the longer path. On
 * a tie a saved rule beats a built-in one, and a newer rule an older one.
 */
export function matchLink(
  link: Pick<ParsedUrl, 'host' | 'path'>,
  projects: Pick<Project, 'slug' | 'github' | 'claudeProject'>[],
  rules: Pick<LinkRule, 'id' | 'projectSlug' | 'host' | 'pathPrefix' | 'createdAt'>[],
): Match | null {
  const candidates: Candidate[] = [
    ...rules.map((r) => ({ slug: r.projectSlug, filedBy: 'rule' as const, ruleId: r.id, host: r.host, pathPrefix: r.pathPrefix, createdAt: r.createdAt.getTime() })),
    ...builtIns(projects),
  ].filter((c) => hostMatches(link.host, c.host) && pathMatches(link.path, c.pathPrefix));
  const score = (c: Candidate) => [c.host === link.host ? 1 : 0, c.host.length, c.pathPrefix.length, c.ruleId !== null ? 1 : 0, c.createdAt];
  const better = (a: Candidate, b: Candidate) => {
    const [x, y] = [score(a), score(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const best = candidates.reduce<Candidate | null>((acc, c) => (!acc || better(c, acc) ? c : acc), null);
  return best && { slug: best.slug, filedBy: best.filedBy, ruleId: best.ruleId };
}

export type RuleChoice = { host: string; pathPrefix: string; label: string };

/**
 * The rules "always file these here" can offer for a link: its whole domain,
 * then its first one and two path segments. `suggested` is the one picked by
 * default: owner/repo on GitHub, else the domain.
 */
export function ruleChoices(url: string): { choices: RuleChoice[]; suggested: number } {
  const { host, path } = parseLink(url);
  const segs = path.split('/').filter(Boolean);
  const choices: RuleChoice[] = [{ host, pathPrefix: '', label: host }];
  for (let n = 1; n <= Math.min(2, segs.length); n++) {
    const pathPrefix = `/${segs.slice(0, n).join('/')}`;
    choices.push({ host, pathPrefix, label: `${host}${pathPrefix}` });
  }
  const suggested = host === 'github.com' && choices.length === 3 ? 2 : 0;
  return { choices, suggested };
}

const allRules = (db: Db) => db.select().from(linkRules).all();

/**
 * Saves a link. With `slug` it is filed there by hand; otherwise the rules
 * decide, else the Inbox. A link already saved (same page) is updated rather
 * than duplicated: a new title replaces the old, and `slug` moves it.
 */
export function addLink(db: Db, projects: Project[], input: { url: string; title?: string | null; slug?: string | null; source: string }, now = new Date()) {
  const parsed = parseLink(input.url);
  const title = input.title?.trim() || null;
  if (input.slug && !projects.some((p) => p.slug === input.slug)) throw new LinkError(404, `Unknown project ${input.slug}`);
  const existing = db.select().from(links).where(eq(links.key, parsed.key)).get();
  if (existing) {
    const set: Partial<Link> = { updatedAt: now, ...(title && { title }), ...(input.slug && { projectSlug: input.slug, filedBy: 'manual', ruleId: null }) };
    db.update(links).set(set).where(eq(links.id, existing.id)).run();
    return { link: getLink(db, existing.id)!, existed: true };
  }
  const match = input.slug ? { slug: input.slug, filedBy: 'manual' as const, ruleId: null } : matchLink(parsed, projects, allRules(db));
  const row = db
    .insert(links)
    .values({
      url: parsed.url,
      key: parsed.key,
      title,
      projectSlug: match?.slug ?? null,
      filedBy: match?.filedBy ?? null,
      ruleId: match?.ruleId ?? null,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return { link: row, existed: false };
}

export const getLink = (db: Db, id: number) => db.select().from(links).where(eq(links.id, id)).get();

/** Files a link by hand, or moves it back to the Inbox (slug null). */
export function fileLink(db: Db, id: number, slug: string | null, now = new Date()) {
  if (!getLink(db, id)) throw new LinkError(404, 'Unknown link');
  db.update(links)
    .set({ projectSlug: slug, filedBy: slug ? 'manual' : null, ruleId: null, updatedAt: now })
    .where(eq(links.id, id))
    .run();
  return getLink(db, id)!;
}

export function deleteLink(db: Db, id: number) {
  if (db.delete(links).where(eq(links.id, id)).run().changes === 0) throw new LinkError(404, 'Unknown link');
}

/**
 * Saves "always file these here". A rule for the same domain and path replaces
 * the old one (it now points at `slug`). Then files every Inbox link it
 * matches; links already filed stay where they are.
 */
export function addRule(db: Db, projects: Project[], input: { slug: string; host: string; pathPrefix: string }, now = new Date()) {
  if (!projects.some((p) => p.slug === input.slug)) throw new LinkError(404, `Unknown project ${input.slug}`);
  const host = normHost(input.host.trim());
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new LinkError(400, `Not a domain: ${input.host}`);
  const pathPrefix = normPath(input.pathPrefix.trim());
  const rule = db
    .insert(linkRules)
    .values({ projectSlug: input.slug, host, pathPrefix, createdAt: now })
    .onConflictDoUpdate({ target: [linkRules.host, linkRules.pathPrefix], set: { projectSlug: input.slug, createdAt: now } })
    .returning()
    .get();
  return { rule, filed: fileInbox(db, projects, now) };
}

export function deleteRule(db: Db, id: number) {
  if (db.delete(linkRules).where(eq(linkRules.id, id)).run().changes === 0) throw new LinkError(404, 'Unknown rule');
}

/** Files every Inbox link that a rule or a project's own entries now match. Returns how many moved. */
export function fileInbox(db: Db, projects: Project[], now = new Date()): number {
  const rules = allRules(db);
  let moved = 0;
  db.transaction((tx) => {
    for (const l of tx.select().from(links).where(isNull(links.projectSlug)).all()) {
      const m = matchLink(parseLink(l.url), projects, rules);
      if (!m) continue;
      tx.update(links).set({ projectSlug: m.slug, filedBy: m.filedBy, ruleId: m.ruleId, updatedAt: now }).where(eq(links.id, l.id)).run();
      moved++;
    }
  });
  return moved;
}

export const inboxLinks = (db: Db) => db.select().from(links).where(isNull(links.projectSlug)).orderBy(desc(links.createdAt), desc(links.id)).all();

export const projectLinks = (db: Db, slug: string) =>
  db.select().from(links).where(eq(links.projectSlug, slug)).orderBy(desc(links.createdAt), desc(links.id)).all();

export const listRules = (db: Db) => db.select().from(linkRules).orderBy(linkRules.host, linkRules.pathPrefix).all();

/** For a deleted project: its links go back to the Inbox and its rules go. */
export function releaseProjectLinks(db: Db | Tx, slug: string) {
  db.update(links).set({ projectSlug: null, filedBy: null, ruleId: null }).where(eq(links.projectSlug, slug)).run();
  db.delete(linkRules).where(eq(linkRules.projectSlug, slug)).run();
}

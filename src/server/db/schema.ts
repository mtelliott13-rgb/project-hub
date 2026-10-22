import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { CollectorConfig } from '../projects.ts';

// Identity and match rules for each project. projects.yaml is the source of
// truth for the match rules; colour, pinned and archived belong to the hub.
export const projects = sqliteTable('projects', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  repos: text('repos', { mode: 'json' }).$type<string[]>().notNull(),
  folders: text('folders', { mode: 'json' }).$type<string[]>().notNull(),
  github: text('github', { mode: 'json' }).$type<string[]>().notNull(),
  claudeProject: text('claude_project'),
  keywords: text('keywords', { mode: 'json' }).$type<string[]>().notNull(),
  // `sessions:` in projects.yaml: session ids pinned to this project.
  pinnedSessions: text('pinned_sessions', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // `collector:` in projects.yaml (see CollectorConfig), or null.
  collector: text('collector', { mode: 'json' }).$type<CollectorConfig | null>(),
  colour: text('colour'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  // Set when a project disappears from projects.yaml, so its history is kept.
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Project = typeof projects.$inferSelect;

// One row per Claude Code session, from hooks or the SDK backfill.
// Prompts are never stored: not from hooks, and not via the SDK summary.
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    // Null means no project matched the folder; Phase 6 files these from the Inbox.
    projectSlug: text('project_slug').references(() => projects.slug),
    cwd: text('cwd').notNull(),
    transcriptPath: text('transcript_path'),
    title: text('title'),
    model: text('model'),
    gitBranch: text('git_branch'),
    // Where it ran, as `claude agents --json` reports it (e.g. "interactive").
    kind: text('kind'),
    // Whether Claude Code has a saved conversation for it (the Agent SDK lists
    // it), so `claude --resume` can reopen it. Sessions that ended before
    // anything was saved, or ran without persistence, never get this.
    resumable: integer('resumable', { mode: 'boolean' }).notNull().default(false),
    state: text('state', { enum: ['running', 'ended'] }).notNull(),
    endReason: text('end_reason'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    lastActiveAt: integer('last_active_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('sessions_project_idx').on(t.projectSlug, t.lastActiveAt)],
);

export type Session = typeof sessions.$inferSelect;

// Phase 6: "always file these here". A link whose host is `host` (or a
// subdomain of it) and whose path starts with `pathPrefix` (whole segments)
// files itself into `projectSlug`. The most specific rule wins.
export const linkRules = sqliteTable(
  'link_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectSlug: text('project_slug')
      .notNull()
      .references(() => projects.slug, { onDelete: 'cascade' }),
    // Lowercase, without a leading www.
    host: text('host').notNull(),
    // '' for the whole domain, else e.g. /document/d (lowercase, no trailing slash).
    pathPrefix: text('path_prefix').notNull().default(''),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('link_rules_host_path_idx').on(t.host, t.pathPrefix)],
);

export type LinkRule = typeof linkRules.$inferSelect;

// Docs and web links (Phase 6). Null projectSlug means the Inbox.
export const links = sqliteTable(
  'links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    url: text('url').notNull(),
    // The URL without its #fragment, host lowercased and www. dropped, so the same page is stored once.
    key: text('key').notNull().unique(),
    title: text('title'),
    projectSlug: text('project_slug').references(() => projects.slug),
    // How it was filed: 'rule' (a saved rule), 'github' or 'claude-project' (the
    // project's own entries in projects.yaml), 'manual'; null in the Inbox.
    filedBy: text('filed_by', { enum: ['rule', 'github', 'claude-project', 'manual'] }),
    ruleId: integer('rule_id').references(() => linkRules.id, { onDelete: 'set null' }),
    // 'paste' (the hub page); Phase 7's extension adds its own.
    source: text('source').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('links_project_idx').on(t.projectSlug, t.createdAt)],
);

export type Link = typeof links.$inferSelect;

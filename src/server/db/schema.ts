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

// Phase 7: claude.ai Projects the hub has seen (from the extension or the data
// export), and which hub project each one's chats file into. projects.yaml's
// `claude_project` also maps one; a mapping here wins.
export const claudeProjects = sqliteTable('claude_projects', {
  // The Claude Project's UUID, lowercase.
  id: text('id').primaryKey(),
  // From the data export's projects.json; the extension doesn't know it.
  name: text('name'),
  projectSlug: text('project_slug').references(() => projects.slug, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type ClaudeProject = typeof claudeProjects.$inferSelect;

// claude.ai chats: id, title and Claude Project only. Never message text.
// Null projectSlug means the Inbox.
export const chats = sqliteTable(
  'chats',
  {
    // The chat's UUID from claude.ai/chat/<id>, lowercase.
    id: text('id').primaryKey(),
    title: text('title'),
    claudeProjectId: text('claude_project_id'),
    projectSlug: text('project_slug').references(() => projects.slug),
    // 'claude-project' (its Claude Project is mapped), 'keyword' (a project
    // keyword is in its title), 'manual' (filed from the Inbox; never re-filed).
    filedBy: text('filed_by', { enum: ['claude-project', 'keyword', 'manual'] }),
    // Where the hub first heard of it: 'extension' or 'export'.
    source: text('source').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    // When you last had it open in Chrome, or its last update in the export.
    lastActiveAt: integer('last_active_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('chats_project_idx').on(t.projectSlug, t.lastActiveAt)],
);

export type Chat = typeof chats.$inferSelect;

// Connectors (Today page): outside services the hub can talk to, all off until
// you click Connect. Only status lives here. Secrets (refresh tokens, client
// secrets, API keys) are in the macOS Keychain (src/server/secrets.ts), never
// in this database.
export const connectors = sqliteTable('connectors', {
  id: text('id').primaryKey(),
  // 'connected' and 'needs-reconnect' come from connecting; 'error' is a failed
  // sync that will be tried again on schedule. No row means not set up.
  state: text('state', { enum: ['not-set-up', 'connected', 'needs-reconnect', 'error'] }).notNull(),
  // What the service calls the account (e.g. the calendar's address); shown on the page.
  account: text('account'),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
  // A short, secret-free reason for 'error' or 'needs-reconnect'.
  lastError: text('last_error'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type ConnectorRow = typeof connectors.$inferSelect;

// Hub preferences set on the Settings page, and connectors' non-secret fields
// (e.g. a Google client ID), as key -> JSON value.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// Calendar events from the Google connector, today through 14 days out,
// replaced on every sync. Only what the Today page shows: never descriptions,
// locations or guests. Times are kept as given (RFC 3339, or YYYY-MM-DD for
// all-day events) plus epoch ms for sorting, in the Mac's time zone.
export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    // Google's event id (one row per occurrence of a repeating event).
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull(),
    start: text('start').notNull(),
    end: text('end').notNull(),
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }).notNull(),
    // Opens the event in Google Calendar.
    htmlLink: text('html_link'),
    // From the event's extendedProperties.private.hubProject (set when the hub creates it).
    projectSlug: text('project_slug'),
    recurring: integer('recurring', { mode: 'boolean' }).notNull().default(false),
    // The hub made it (extendedProperties.private.hubCreated); only these can be deleted from the hub (Undo).
    createdByHub: integer('created_by_hub', { mode: 'boolean' }).notNull().default(false),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('calendar_events_start_idx').on(t.startsAt)],
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;

// Tasks (Today page): reminders with no date. Completed ones stay until the
// day is over (the page folds them into "Done today"), then drop off the page.
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    projectSlug: text('project_slug').references(() => projects.slug, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('tasks_project_idx').on(t.projectSlug)],
);

export type Task = typeof tasks.$inferSelect;

// "Add to calendar?" suggestions next to dates in project notes that you
// dismissed (or added), so they aren't offered again. Only a SHA-256 of the
// note line is kept, never its text.
export const noteDismissals = sqliteTable(
  'note_dismissals',
  {
    projectSlug: text('project_slug')
      .notNull()
      .references(() => projects.slug, { onDelete: 'cascade' }),
    lineHash: text('line_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('note_dismissals_idx').on(t.projectSlug, t.lineHash)],
);

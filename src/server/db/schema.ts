import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  colour: text('colour'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  // Set when a project disappears from projects.yaml, so its history is kept.
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Project = typeof projects.$inferSelect;

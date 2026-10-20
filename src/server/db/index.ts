import Database from 'better-sqlite3';
import { asc, eq, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { ProjectConfig } from '../projects.ts';
import { projects, type Project } from './schema.ts';

export type Db = ReturnType<typeof openDb>;

/** Opens (or creates) the SQLite file and applies any pending migrations. */
export function openDb(file: string, migrationsFolder: string) {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder });
  return db;
}

/**
 * Upserts every project from projects.yaml and archives the ones that are
 * no longer listed, so a project removed by hand keeps its history. (Delete
 * from the hub page removes the row as well.) Hub-owned fields (colour,
 * pinned) are left alone.
 */
export function syncProjects(db: Db, configs: ProjectConfig[], now = new Date()) {
  db.transaction((tx) => {
    for (const c of configs) {
      const rules = {
        name: c.name,
        repos: c.repos,
        folders: c.folders,
        github: c.github,
        claudeProject: c.claude_project ?? null,
        keywords: c.keywords,
        pinnedSessions: c.sessions,
        archived: c.archived,
        updatedAt: now,
      };
      tx.insert(projects)
        .values({ slug: c.slug, ...rules, createdAt: now })
        .onConflictDoUpdate({ target: projects.slug, set: rules })
        .run();
    }
    tx.update(projects)
      .set({ archived: true, updatedAt: now })
      .where(notInArray(projects.slug, configs.map((c) => c.slug)))
      .run();
  });
}

/** Every project the hub knows, archived ones included. Sessions match against these. */
export function listAllProjects(db: Db): Project[] {
  return db.select().from(projects).orderBy(asc(projects.name)).all();
}

export function listActiveProjects(db: Db): Project[] {
  return db.select().from(projects).where(eq(projects.archived, false)).orderBy(asc(projects.name)).all();
}

// What the hub knows about each project, gathered for the page's activity
// routes and the read-only /agent routes: the timeline inputs (Phase 8) and the
// toolkit summary on the card.
import fs from 'node:fs';
import { isNotNull } from 'drizzle-orm';
import type { ActivityInput } from './activity.ts';
import { listAllProjects, type Db } from './db/index.ts';
import { chats, links } from './db/schema.ts';
import type { FileWatcher } from './files.ts';
import { matchProject } from './matching.ts';
import type { RepoPoller } from './repos.ts';
import { resumeProblem, sessionsForProjects } from './sessions.ts';
import { findToolkitFiles, readToolkit } from './toolkit.ts';

/**
 * Timeline inputs per project (all of them, or just `slugs`), built from what
 * the hub already has. Recent files are only what the watcher has seen (in
 * memory), commits the last 10 per repo, CI the newest run.
 */
export function activityInputs({ db, repos, files }: { db: Db; repos: RepoPoller; files: FileWatcher }, slugs?: string[]): Map<string, ActivityInput> {
  const all = listAllProjects(db);
  const wanted = all.filter((p) => !slugs || slugs.includes(p.slug));
  const exists = (dir: string) => fs.existsSync(dir);
  const listed = sessionsForProjects(db, wanted.map((p) => p.slug))
    .map((s) => ({ ...s, resumeProblem: resumeProblem(s, exists) }))
    .filter((s) => s.resumeProblem === null || s.state === 'running');
  const filedChats = db.select().from(chats).where(isNotNull(chats.projectSlug)).all();
  const filedLinks = db.select().from(links).where(isNotNull(links.projectSlug)).all();
  const recent = files.recent(() => true, 5000);
  const out = new Map<string, ActivityInput>();
  for (const p of wanted)
    out.set(p.slug, {
      sessions: listed.filter((s) => s.projectSlug === p.slug),
      chats: filedChats.filter((ch) => ch.projectSlug === p.slug),
      repos: p.repos.map((dir) => repos.get(dir)),
      files: recent.filter((f) => matchProject(f.path, all) === p.slug),
      links: filedLinks.filter((l) => l.projectSlug === p.slug),
    });
  return out;
}

/** "Toolkit: X of Y done" for a card: the first toolkit.yaml in the project's repos or folders, if any. */
export function toolkitSummary(p: { repos: string[]; folders: string[] }) {
  const [file] = findToolkitFiles(p);
  if (!file) return null;
  try {
    const t = readToolkit(file);
    return { file, done: t.done, total: t.total, error: null };
  } catch (e) {
    return { file, done: 0, total: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

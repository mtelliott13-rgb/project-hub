import path from 'node:path';
import type { Db } from '../src/server/db/index.ts';
import { ChangeFeed } from '../src/server/events.ts';
import type { Listener } from '../src/server/collector.ts';
import type { LaunchPlan } from '../src/server/launcher.ts';
import { createProjectStore } from '../src/server/project-store.ts';
import { projectDocs } from '../src/server/docs.ts';
import { monetizeJobs, type MonetizeResult } from '../src/server/monetize.ts';
import { repoPoller, type RepoStatus } from '../src/server/repos.ts';
import { fileWatcher, type WatchedRoot } from '../src/server/files.ts';

/** The hub's own origin in tests; requests go to full URLs so the Host check sees it. */
export const HUB = 'http://127.0.0.1:4747';

/** Headers for a GET from the hub page: its token (browsers send no Origin on same-origin GETs). */
export const PAGE_GET = { 'X-Hub-Token': 'ui-t0ken' };

/**
 * createApp deps with a launcher that records plans instead of running them,
 * a projects.yaml, notes and ideas next to the test database, and a Generate
 * that returns a canned draft.
 */
export function testDeps(db: Db) {
  const launched: LaunchPlan[] = [];
  // Fake processes for collector tests: port -> listeners.
  const listening = new Map<number, Listener[]>();
  // Repo checks never touch git or GitHub here: they return what's in `repoStates`.
  const repoStates = new Map<string, Omit<RepoStatus, 'dir' | 'checkedAt'>>();
  const repoChecks: string[] = [];
  let repoDirs: string[] = [];
  const repos = repoPoller({
    repos: () => repoDirs,
    check: async (dir) => {
      repoChecks.push(dir);
      const s = repoStates.get(dir) ?? { git: null, gitError: 'no fake state', github: null, githubError: null };
      return { dir, checkedAt: new Date().toISOString(), ...s };
    },
    onChange: () => {},
  });
  // Recent files: nothing is watched until a test sets roots and calls files.sync().
  let fileRoots: WatchedRoot[] = [];
  const fileChanges: number[] = [];
  const files = fileWatcher({ roots: () => fileRoots, onChange: () => fileChanges.push(Date.now()), debounceMs: 50, log: () => {} });
  const dir = path.dirname(db.$client.name);
  const projectsFile = path.join(dir, 'projects.yaml');
  const store = createProjectStore(db, projectsFile, path.join(dir, 'backups/projects.last.yaml'), () => {});
  const docs = projectDocs(path.join(dir, 'projects'));
  // Generate never runs Claude in tests: it returns a canned draft.
  const generated: string[] = [];
  const jobs = monetizeJobs(
    async (slug): Promise<MonetizeResult> => {
      generated.push(slug);
      return { text: `## Who would pay\nDraft for ${slug}\n`, costUsd: 0.12 };
    },
    (slug, result) => docs.addDraft(slug, result.text, result.costUsd),
    () => {},
  );
  return {
    launched,
    listening,
    repos,
    repoStates,
    repoChecks,
    setRepoDirs: (dirs: string[]) => {
      repoDirs = dirs;
    },
    files,
    fileChanges,
    setFileRoots: (roots: WatchedRoot[]) => {
      fileRoots = roots;
    },
    projectsFile,
    store,
    docs,
    generated,
    deps: {
      store,
      docs,
      ideasFile: path.join(dir, 'ideas.md'),
      jobs,
      db,
      webDir: '/nonexistent',
      token: 't0ken',
      feed: new ChangeFeed(),
      uiToken: 'ui-t0ken',
      origins: [HUB, 'http://localhost:4747'],
      launcher: async (plan: LaunchPlan) => void launched.push(plan),
      claudeDesktopInstalled: true,
      probe: { listeners: async (port: number) => listening.get(port) ?? [] },
      repos,
      toolkitBackupDir: path.join(dir, 'backups/toolkit'),
      files,
    },
  };
}

import path from 'node:path';
import type { Db } from '../src/server/db/index.ts';
import { ChangeFeed } from '../src/server/events.ts';
import type { LaunchPlan } from '../src/server/launcher.ts';
import { createProjectStore } from '../src/server/project-store.ts';
import { projectDocs } from '../src/server/docs.ts';
import { monetizeJobs, type MonetizeResult } from '../src/server/monetize.ts';

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
    },
  };
}

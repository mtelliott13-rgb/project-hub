// projects.yaml <-> database. The file is the source of truth: the hub page
// writes to it, then reloads from it, the same way a hand edit is picked up.
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { listAllProjects, syncProjects, type Db } from './db/index.ts';
import { projects, sessions, type Project } from './db/schema.ts';
import {
  addProject,
  ProjectsFileError,
  removeProject,
  setArchived,
  slugFor,
  updateProject,
  type ProjectInput,
} from './projects-file.ts';
import { loadProjects } from './projects.ts';
import { rematchSessions } from './sessions.ts';

const EMPTY_FILE = '# ~/.project-hub/projects.yaml\nprojects:\n';

export type ProjectStore = ReturnType<typeof createProjectStore>;

/**
 * `onChange` runs after every reload, good or bad. `backupFile` gets a copy
 * of projects.yaml before each save from the page.
 */
export function createProjectStore(db: Db, file: string, backupFile: string, onChange: () => void) {
  let error: string | null = null;

  /** Re-reads projects.yaml. A broken file leaves the last good state in place. */
  function reload() {
    try {
      syncProjects(db, loadProjects(file));
      rematchSessions(db, listAllProjects(db));
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    onChange();
  }

  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : EMPTY_FILE);

  /** Backs up, then writes via a temp file so a crash never leaves half a file. */
  function save(edit: (text: string) => string) {
    const before = read();
    const after = edit(before);
    if (after !== before) {
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, backupFile);
      const tmp = `${file}.project-hub-tmp`;
      fs.writeFileSync(tmp, after);
      fs.renameSync(tmp, file);
    }
    reload();
  }

  const find = (slug: string): Project => {
    const p = db.select().from(projects).where(eq(projects.slug, slug)).get();
    if (!p) throw new ProjectsFileError(`Unknown project ${slug}`);
    return p;
  };

  return {
    reload,
    error: () => error,

    add(input: ProjectInput): string {
      const slug = slugFor(input.name, listAllProjects(db).map((p) => p.slug));
      save((text) => addProject(text, slug, input));
      return slug;
    },

    update(slug: string, input: ProjectInput) {
      find(slug);
      save((text) => updateProject(text, slug, input));
    },

    setArchived(slug: string, archived: boolean) {
      const p = find(slug);
      save((text) =>
        setArchived(text, slug, archived, {
          slug: p.slug,
          name: p.name,
          repos: p.repos,
          folders: p.folders,
          github: p.github,
          claude_project: p.claudeProject ?? undefined,
          keywords: p.keywords,
          sessions: p.pinnedSessions,
          archived: false,
          collector: p.collector ?? undefined,
        }),
      );
    },

    /**
     * Removes the hub's record only: the projects.yaml entry and the database
     * row. Its sessions stay, unfiled. Nothing on disk outside ~/.project-hub
     * is touched.
     */
    remove(slug: string): number {
      find(slug);
      save((text) => removeProject(text, slug));
      const unfiled = db.transaction((tx) => {
        const n = tx.update(sessions).set({ projectSlug: null }).where(eq(sessions.projectSlug, slug)).run().changes;
        tx.delete(projects).where(eq(projects.slug, slug)).run();
        return n;
      });
      reload();
      return unfiled;
    },
  };
}

/**
 * Calls `reload` when a file changes on disk, e.g. projects.yaml. Watches the
 * folder, since editors and the hub itself replace the file rather than
 * write into it. macOS file events can arrive late or not at all, so a
 * once-a-second check of the file's size, time and inode backs them up.
 */
export function watchFile(file: string, reload: () => void, pollMs = 1000): { close: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const fingerprint = () => {
    try {
      const st = fs.statSync(file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return 'missing';
    }
  };
  let last = fingerprint();
  const changed = () => {
    last = fingerprint();
    clearTimeout(timer);
    timer = setTimeout(reload, 150);
  };
  const name = path.basename(file);
  const watcher = fs.watch(path.dirname(file), (_event, f) => {
    if (f === null || f === name) changed();
  });
  const poll = setInterval(() => {
    if (fingerprint() !== last) changed();
  }, pollMs);
  poll.unref();
  return {
    close() {
      watcher.close();
      clearInterval(poll);
      clearTimeout(timer);
    },
  };
}

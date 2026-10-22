// Recently changed files (SPEC.md, Phase 6). Every active project's repos and
// folders are watched with chokidar. Skipped: .git, node_modules, build output,
// editor and OS litter, and in a repo anything git ignores (Meme Radar's data/
// holds a browser profile and a database that change all the time). Only file
// names and times are kept, in memory; the first scan seeds the list from the
// files' modification times, so a restart loses nothing that matters.
import path from 'node:path';
import { execa } from 'execa';
import { watch, type FSWatcher } from 'chokidar';

/** Folders never watched, wherever they are. */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  // Build output and caches.
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  // Editor and app state that changes as you click around.
  '.idea',
  '.obsidian',
  '.trash',
  '.Trash',
]);

// Files that are never yours to open: OS litter, editor swap and lock files,
// SQLite's side files, and the hub's own temp files.
const NOISE = /^(\.DS_Store|Icon\r|\.#.*|~\$.*|\.~lock\..*)$|\.(sw[a-p]|tmp|pyc)$|~$|-journal$|\.db-(wal|shm)$|\.sqlite-(wal|shm)$|\.project-hub-tmp$/;

export function ignoredByName(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (rel === '' || rel.startsWith('..')) return false;
  const parts = rel.split(path.sep);
  return parts.some((s) => IGNORED_DIRS.has(s)) || NOISE.test(parts[parts.length - 1]);
}

/** What git ignores in a repo; tests pass a fake. */
export type GitIgnore = {
  /** Ignored files and folders at the start, as absolute paths (folders without a trailing slash). */
  ignoredPaths: (repo: string) => Promise<string[]>;
  /** Which of `paths` (absolute) git ignores. */
  check: (repo: string, paths: string[]) => Promise<Set<string>>;
};

// The same minimal environment Phase 5 uses: never take git's optional locks.
const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const git = (repo: string, args: string[], input?: string) =>
  execa('git', ['-C', repo, ...args], { env: GIT_ENV, extendEnv: false, input, reject: false, timeout: 30_000 });

export const realGitIgnore: GitIgnore = {
  async ignoredPaths(repo) {
    const r = await git(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
    if (r.exitCode !== 0) return [];
    return String(r.stdout).split('\0').filter(Boolean).map((rel) => path.join(repo, rel.replace(/\/$/, '')));
  },
  async check(repo, paths) {
    if (paths.length === 0) return new Set();
    // Exit code 1 means none of them is ignored.
    const r = await git(repo, ['check-ignore', '-z', '--stdin'], paths.map((p) => path.relative(repo, p)).join('\0'));
    if (r.exitCode !== 0) return new Set();
    return new Set(String(r.stdout).split('\0').filter(Boolean).map((rel) => path.join(repo, rel)));
  },
};

export type WatchedRoot = { dir: string; repo: boolean };
export type RecentFile = { path: string; root: string; rel: string; mtime: string };

type RootState = {
  root: WatchedRoot;
  watcher: FSWatcher | null;
  files: Map<string, number>; // path -> mtimeMs
  ignored: Set<string>; // paths git ignores (files or folders)
  allowed: Set<string>; // paths git was asked about and doesn't ignore
  pending: Map<string, number>; // seen, waiting for the git check
  timer: NodeJS.Timeout | undefined;
  ready: boolean;
  closed: boolean;
  error: string | null;
};

/**
 * Watches `roots()` (re-read by `sync`). `onChange` runs, at most every
 * `debounceMs`, after files change once the first scan is done. Keeps about
 * the `keep` newest files per root.
 */
export function fileWatcher(opts: {
  roots: () => WatchedRoot[];
  onChange: () => void;
  gitIgnore?: GitIgnore;
  keep?: number;
  debounceMs?: number;
  log?: (msg: string) => void;
}) {
  const gitIgnore = opts.gitIgnore ?? realGitIgnore;
  const keep = opts.keep ?? 200;
  const debounceMs = opts.debounceMs ?? 300;
  const log = opts.log ?? ((m: string) => console.error(`${new Date().toISOString()} ${m}`));
  const states = new Map<string, RootState>();
  let notifyTimer: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(opts.onChange, debounceMs);
  };

  const underIgnored = (s: RootState, p: string) => {
    for (let d = p; d.length > s.root.dir.length; d = path.dirname(d)) if (s.ignored.has(d)) return true;
    return false;
  };
  const isIgnored = (s: RootState, p: string) => ignoredByName(s.root.dir, p) || underIgnored(s, p);

  function prune(s: RootState) {
    if (s.files.size <= keep * 2) return;
    const newest = [...s.files].sort((a, b) => b[1] - a[1]).slice(0, keep);
    s.files = new Map(newest);
  }

  /** Records pending files, after asking git about the ones it hasn't been asked about. */
  async function flush(s: RootState) {
    s.timer = undefined;
    const batch = [...s.pending];
    s.pending.clear();
    if (s.root.repo) {
      const unknown = batch.map(([p]) => p).filter((p) => !s.allowed.has(p) && !s.ignored.has(p));
      try {
        const ignored = await gitIgnore.check(s.root.dir, unknown);
        for (const p of unknown) (ignored.has(p) ? s.ignored : s.allowed).add(p);
      } catch (e) {
        log(`git check-ignore in ${s.root.dir} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (s.closed) return;
    let any = false;
    for (const [p, mtime] of batch) {
      if (isIgnored(s, p)) continue;
      s.files.set(p, mtime);
      any = true;
    }
    prune(s);
    if (any && s.ready) changed();
  }

  const queue = (s: RootState, p: string, mtime: number) => {
    s.pending.set(p, mtime);
    s.timer ??= setTimeout(() => void flush(s), 100);
  };

  async function start(root: WatchedRoot) {
    const s: RootState = { root, watcher: null, files: new Map(), ignored: new Set(), allowed: new Set(), pending: new Map(), timer: undefined, ready: false, closed: false, error: null };
    states.set(root.dir, s);
    if (root.repo) {
      try {
        for (const p of await gitIgnore.ignoredPaths(root.dir)) s.ignored.add(p);
      } catch (e) {
        log(`git ls-files in ${root.dir} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (s.closed) return;
    const w = watch(root.dir, {
      ignored: (p: string) => isIgnored(s, p),
      ignoreInitial: false,
      alwaysStat: true,
      followSymlinks: false,
      persistent: true,
    });
    s.watcher = w;
    w.on('add', (p, st) => queue(s, p, st?.mtimeMs ?? Date.now()));
    w.on('change', (p, st) => {
      // A changed .gitignore changes what's skipped: start this folder over.
      if (root.repo && path.basename(p) === '.gitignore') return void restart(root);
      queue(s, p, st?.mtimeMs ?? Date.now());
    });
    w.on('unlink', (p) => {
      s.pending.delete(p);
      if (s.files.delete(p) && s.ready) changed();
    });
    w.on('unlinkDir', (dir) => {
      let any = false;
      for (const p of s.files.keys()) if (p.startsWith(dir + path.sep)) any = s.files.delete(p) || any;
      if (any && s.ready) changed();
    });
    w.on('ready', () => {
      // Let the first scan's git check land before saying it's ready.
      setTimeout(() => {
        s.ready = true;
        changed();
      }, 0);
    });
    w.on('error', (e) => {
      s.error = e instanceof Error ? e.message : String(e);
      log(`Watching ${root.dir} failed: ${s.error}`);
    });
  }

  function stop(dir: string) {
    const s = states.get(dir);
    if (!s) return;
    s.closed = true;
    clearTimeout(s.timer);
    void s.watcher?.close();
    states.delete(dir);
  }

  function restart(root: WatchedRoot) {
    stop(root.dir);
    void start(root);
  }

  return {
    /** Starts watching new roots and stops watching ones no longer listed. */
    sync() {
      const wanted = new Map(opts.roots().map((r) => [r.dir, r]));
      for (const [dir, s] of states) {
        const w = wanted.get(dir);
        if (!w) stop(dir);
        else if (w.repo !== s.root.repo) restart(w);
      }
      for (const [dir, r] of wanted) if (!states.has(dir)) void start(r);
    },
    /** Files `include` accepts, newest first, with the folder each was found under. */
    recent(include: (file: string) => boolean, limit = 50): RecentFile[] {
      const seen = new Map<string, RecentFile>();
      for (const s of states.values()) {
        for (const [p, mtime] of s.files) {
          if (seen.has(p) || !include(p)) continue;
          seen.set(p, { path: p, root: s.root.dir, rel: path.relative(s.root.dir, p), mtime: new Date(mtime).toISOString() });
        }
      }
      return [...seen.values()].sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, limit);
    },
    /** Each watched folder, whether its first scan is done, and any error. */
    status: () => [...states.values()].map((s) => ({ dir: s.root.dir, ready: s.ready, error: s.error })),
    close() {
      for (const dir of [...states.keys()]) stop(dir);
      clearTimeout(notifyTimer);
    },
  };
}

export type FileWatcher = ReturnType<typeof fileWatcher>;

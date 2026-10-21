// Repo and GitHub status (SPEC.md, Phase 5): branch, uncommitted files,
// ahead/behind, the last 10 commits, open PRs and CI. Read-only: the hub never
// fetches, commits or pushes. Ahead/behind compare with the remote branch as
// of your last fetch or push.
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { simpleGit } from 'simple-git';
import { z } from 'zod';

export type Commit = { hash: string; short: string; date: string; subject: string; author: string };

export type GitStatus = {
  branch: string | null; // null when detached
  tracking: string | null; // e.g. origin/main, or null when the branch has no upstream
  uncommitted: number;
  ahead: number;
  behind: number;
  commits: Commit[];
  remoteUrl: string | null;
};

export type Check = 'passing' | 'failing' | 'pending' | 'none';

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
  author: string | null;
  updatedAt: string;
  checks: Check;
};

export type GithubStatus = {
  repo: string; // owner/repo
  prs: PullRequest[];
  // The newest Actions run on the current branch, if any.
  ci: { state: Check; workflow: string; url: string; at: string } | null;
};

export type RepoStatus = {
  dir: string;
  checkedAt: string;
  git: GitStatus | null;
  gitError: string | null;
  // null when the repo isn't on GitHub (no github.com remote).
  github: GithubStatus | null;
  githubError: string | null;
};

const message = (e: unknown) => (e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e));

// A minimal environment: no optional locks (so polling never blocks your own
// git commands), English output for parsing, and nothing like GIT_EDITOR
// inherited from wherever the hub was started.
const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/** git status and log, without taking git's optional locks, so it never gets in your way. */
export async function gitStatus(dir: string): Promise<GitStatus> {
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`Not a git repo: ${dir}`);
  const git = simpleGit({ baseDir: dir, timeout: { block: 15_000 }, allowEnvironment: ['GIT_OPTIONAL_LOCKS'] }).env(GIT_ENV);
  const status = await git.status();
  let commits: Commit[] = [];
  try {
    const log = await git.log({ maxCount: 10 });
    commits = log.all.map((c) => ({ hash: c.hash, short: c.hash.slice(0, 7), date: new Date(c.date).toISOString(), subject: c.message, author: c.author_name }));
  } catch (e) {
    if (!/does not have any commits/.test(message(e))) throw e;
  }
  const origin = (await git.getRemotes(true)).find((r) => r.name === 'origin');
  return {
    branch: status.detached ? null : status.current,
    tracking: status.tracking,
    uncommitted: status.files.length,
    ahead: status.ahead,
    behind: status.behind,
    commits,
    remoteUrl: origin?.refs.fetch ?? null,
  };
}

/** owner/repo from a github.com remote URL (https or ssh), else null. */
export function githubRepo(url: string | null): string | null {
  const m = url?.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// What gh returns; anything else is ignored.
const rollupItem = z.object({
  // CheckRun has status + conclusion; StatusContext has state.
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().optional(),
});
const prSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    headRefName: z.string(),
    isDraft: z.boolean(),
    updatedAt: z.string(),
    author: z.object({ login: z.string() }).nullable().optional(),
    statusCheckRollup: z.array(rollupItem).nullable().optional(),
  }),
);
const runSchema = z.array(
  z.object({ status: z.string(), conclusion: z.string().nullable().optional(), workflowName: z.string(), url: z.string(), createdAt: z.string() }),
);

const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
const OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'success', 'neutral', 'skipped']);

/** One state for a PR's checks: any failure fails, anything unfinished is pending. */
export function summarizeChecks(items: z.infer<typeof rollupItem>[] | null | undefined): Check {
  if (!items?.length) return 'none';
  const results = items.map((i) => i.conclusion || i.state || (i.status && i.status !== 'COMPLETED' ? 'PENDING' : ''));
  if (results.some((r) => FAILED.has(r))) return 'failing';
  if (results.every((r) => OK.has(r))) return 'passing';
  return 'pending';
}

export const runCheck = (status: string, conclusion: string | null | undefined): Check =>
  status !== 'completed' ? 'pending' : conclusion && FAILED.has(conclusion) ? 'failing' : 'passing';

/** Runs gh; tests pass a fake. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>;

export const ghRunner =
  (gh: string): GhRunner =>
  async (args, cwd) =>
    (await execa(gh, args, { cwd, stdin: 'ignore', timeout: 30_000 })).stdout;

/** Open PRs (with their checks) and the newest CI run on `branch`, via gh. */
export async function githubStatus(repo: string, branch: string | null, dir: string, gh: GhRunner): Promise<GithubStatus> {
  const prs = prSchema.parse(
    JSON.parse(
      await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '20', '--json', 'number,title,url,headRefName,isDraft,updatedAt,author,statusCheckRollup'], dir),
    ),
  );
  let ci: GithubStatus['ci'] = null;
  if (branch) {
    const [run] = runSchema.parse(
      JSON.parse(await gh(['run', 'list', '--repo', repo, '--branch', branch, '--limit', '1', '--json', 'status,conclusion,workflowName,url,createdAt'], dir)),
    );
    if (run) ci = { state: runCheck(run.status, run.conclusion), workflow: run.workflowName, url: run.url, at: run.createdAt };
  }
  return {
    repo,
    ci,
    prs: prs.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.headRefName,
      draft: p.isDraft,
      author: p.author?.login ?? null,
      updatedAt: p.updatedAt,
      checks: summarizeChecks(p.statusCheckRollup),
    })),
  };
}

/** Everything about one repo; its GitHub repo comes from its origin remote. Never throws: failures are reported per part. */
export async function repoStatus(dir: string, gh: GhRunner): Promise<RepoStatus> {
  const out: RepoStatus = { dir, checkedAt: new Date().toISOString(), git: null, gitError: null, github: null, githubError: null };
  try {
    out.git = await gitStatus(dir);
  } catch (e) {
    out.gitError = message(e);
    return out;
  }
  const repo = githubRepo(out.git.remoteUrl);
  if (!repo) return out;
  try {
    out.github = await githubStatus(repo, out.git.branch, dir, gh);
  } catch (e) {
    out.githubError = message(e);
  }
  return out;
}

/**
 * Keeps every project repo's status fresh: all of them every `everyMs`, and
 * one on demand (after a Stop event, or the page's Refresh). One check per
 * repo at a time; a request during a check runs once more when it finishes.
 */
export function repoPoller(opts: {
  repos: () => string[];
  check: (dir: string) => Promise<RepoStatus>;
  onChange: () => void;
}) {
  const cache = new Map<string, RepoStatus>();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  function refresh(dir: string): Promise<void> {
    const inFlight = running.get(dir);
    if (inFlight) {
      again.add(dir);
      return inFlight;
    }
    const p = opts
      .check(dir)
      .then((s) => {
        cache.set(dir, s);
        opts.onChange();
      })
      .finally(() => {
        running.delete(dir);
        if (again.delete(dir)) void refresh(dir);
      });
    running.set(dir, p);
    return p;
  }

  return {
    get: (dir: string) => cache.get(dir) ?? null,
    refresh,
    refreshAll: () => Promise.all([...new Set(opts.repos())].map(refresh)).then(() => undefined),
    /** The repos a session folder belongs to (it may be inside one, e.g. a worktree). */
    reposFor: (cwd: string) => [...new Set(opts.repos())].filter((dir) => cwd === dir || cwd.startsWith(dir + path.sep)),
  };
}

export type RepoPoller = ReturnType<typeof repoPoller>;

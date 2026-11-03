import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import {
  githubRepo,
  githubStatus,
  gitStatus,
  repoPoller,
  awaitingCi,
  repoStatus,
  runCheck,
  summarizeChecks,
  type GhRunner,
  type RepoStatus,
} from '../src/server/repos.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-')));
  dirs.push(d);
  return d;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: cwd },
  }).toString();

/** A bare "GitHub" plus a clone of it with one pushed commit. */
function repoPair() {
  const root = tmp();
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', '-q', remote, work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'First commit');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote, work };
}

describe('git status', () => {
  it('reads branch, tracking, uncommitted and the last commits', async () => {
    const { work } = repoPair();
    expect(await gitStatus(work)).toMatchObject({ branch: 'main', tracking: 'origin/main', uncommitted: 0, ahead: 0, behind: 0 });
    fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(work, 'new.txt'), 'untracked\n');
    const s = await gitStatus(work);
    expect(s.uncommitted).toBe(2);
    expect(s.commits).toEqual([expect.objectContaining({ subject: 'First commit', author: 'Test', short: expect.stringMatching(/^[0-9a-f]{7}$/) })]);
  });

  it('counts ahead after a local commit, and behind once a fetch sees new remote commits', async () => {
    const { root, remote, work } = repoPair();
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(work, 'a.txt'), `v${i}\n`);
      git(work, 'commit', '-qam', `Commit ${i}`);
    }
    const ahead = await gitStatus(work);
    expect(ahead).toMatchObject({ ahead: 12, behind: 0 });
    expect(ahead.commits).toHaveLength(10); // only the last 10
    expect(ahead.commits[0].subject).toBe('Commit 12');

    git(work, 'push', '-q');
    expect(await gitStatus(work)).toMatchObject({ ahead: 0 }); // a push shows straight away

    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    fs.writeFileSync(path.join(other, 'b.txt'), 'from elsewhere\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'Pushed from another machine');
    git(other, 'push', '-q');
    expect(await gitStatus(work)).toMatchObject({ behind: 0 }); // the hub doesn't fetch
    git(work, 'fetch', '-q');
    expect(await gitStatus(work)).toMatchObject({ behind: 1 });
  });

  it('handles a branch with no upstream, a detached HEAD, an empty repo and a non-repo', async () => {
    const { work, root } = repoPair();
    git(work, 'checkout', '-qb', 'feature');
    expect(await gitStatus(work)).toMatchObject({ branch: 'feature', tracking: null });
    git(work, 'checkout', '-q', '--detach');
    expect((await gitStatus(work)).branch).toBeNull();

    const empty = path.join(root, 'empty');
    git(root, 'init', '-q', empty);
    expect(await gitStatus(empty)).toMatchObject({ commits: [], uncommitted: 0 });
    await expect(gitStatus(root)).rejects.toThrow(/Not a git repo/);
  });

  it('never takes git locks or rewrites the index while you work', async () => {
    const { work } = repoPair();
    const index = path.join(work, '.git/index');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(work, 'a.txt'), new Date(), new Date()); // stat info changes, content doesn't
    fs.utimesSync(index, past, past);
    await gitStatus(work);
    expect(Math.abs(fs.statSync(index).mtimeMs - past.getTime())).toBeLessThan(1);
    expect(fs.existsSync(path.join(work, '.git/index.lock'))).toBe(false);
    // Control: a plain `git status` (optional locks on) does refresh the index.
    git(work, 'status', '--short');
    expect(fs.statSync(index).mtimeMs - past.getTime()).toBeGreaterThan(1000);
  });
});

describe('GitHub', () => {
  it('finds owner/repo in https and ssh remotes', () => {
    expect(githubRepo('https://github.com/mtelliott13-rgb/project-hub.git')).toBe('mtelliott13-rgb/project-hub');
    expect(githubRepo('git@github.com:me/some.repo.git')).toBe('me/some.repo');
    expect(githubRepo('https://github.com/me/repo')).toBe('me/repo');
    expect(githubRepo('https://gitlab.com/me/repo.git')).toBeNull();
    expect(githubRepo(null)).toBeNull();
  });

  it('sums up checks: any failure fails, anything unfinished is pending', () => {
    expect(summarizeChecks([])).toBe('none');
    expect(summarizeChecks(null)).toBe('none');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('passing');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('pending');
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failing');
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending');
    expect(runCheck('in_progress', null)).toBe('pending');
    expect(runCheck('completed', 'success')).toBe('passing');
    expect(runCheck('completed', 'failure')).toBe('failing');
  });

  it('reads open PRs and the branch CI with read-only gh commands', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr')
        return JSON.stringify([
          {
            number: 7,
            title: 'Phase 5 check',
            url: 'https://github.com/me/r/pull/7',
            headRefName: 'phase-5-check',
            isDraft: false,
            updatedAt: '2026-10-21T19:00:00Z',
            author: { login: 'me' },
            statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
            unexpected: 'ignored',
          },
        ]);
      return JSON.stringify([{ status: 'completed', conclusion: 'success', workflowName: 'CI', url: 'https://github.com/me/r/actions/runs/1', createdAt: '2026-10-21T18:00:00Z', headSha: 'abc123' }]);
    };
    const s = await githubStatus('me/r', 'main', '/u/r', gh);
    expect(s).toEqual({
      repo: 'me/r',
      ci: { state: 'passing', workflow: 'CI', url: 'https://github.com/me/r/actions/runs/1', at: '2026-10-21T18:00:00Z', sha: 'abc123' },
      prs: [{ number: 7, title: 'Phase 5 check', url: 'https://github.com/me/r/pull/7', branch: 'phase-5-check', draft: false, author: 'me', updatedAt: '2026-10-21T19:00:00Z', checks: 'failing' }],
    });
    expect(calls.map((a) => a.slice(0, 2).join(' '))).toEqual(['pr list', 'run list']);
    expect(calls.flat()).not.toContain('create');
  });

  it('a repo without a GitHub remote never calls gh; a gh failure keeps the git part', async () => {
    const { work } = repoPair(); // its origin is a local bare repo
    let called = 0;
    const s = await repoStatus(work, async () => {
      called++;
      return '[]';
    });
    expect(s).toMatchObject({ github: null, githubError: null, gitError: null });
    expect(called).toBe(0);

    git(work, 'remote', 'set-url', 'origin', 'https://github.com/me/r.git');
    const failing = await repoStatus(work, async () => {
      throw new Error('gh: not logged in');
    });
    expect(failing).toMatchObject({ github: null, githubError: 'gh: not logged in', git: { branch: 'main' } });

    expect((await repoStatus(work, async () => '[]')).github).toMatchObject({ ci: null, workflows: false });
    fs.mkdirSync(path.join(work, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github/workflows/ci.yml'), 'name: CI\n');
    expect((await repoStatus(work, async () => '[]')).github).toMatchObject({ ci: null, workflows: true });
  });
});

describe('repo poller', () => {
  it('runs one check per repo at a time, and once more if asked during one', async () => {
    const started: string[] = [];
    let release!: () => void;
    const poller = repoPoller({
      repos: () => ['/u/a', '/u/b', '/u/a'],
      check: (dir) => {
        started.push(dir);
        return new Promise<RepoStatus>((r) => {
          release = () => r({ dir, checkedAt: '', git: null, gitError: null, github: null, githubError: null });
        });
      },
      onChange: () => {},
    });
    const first = poller.refresh('/u/a');
    void poller.refresh('/u/a');
    void poller.refresh('/u/a');
    expect(started).toEqual(['/u/a']);
    release();
    await first;
    await expect.poll(() => started).toEqual(['/u/a', '/u/a']); // the two extra asks collapse into one rerun
    release();
    expect(poller.reposFor('/u/a/.claude/worktrees/x')).toEqual(['/u/a']);
    expect(poller.reposFor('/u/ab')).toEqual([]);
  });
});

describe('following a CI run', () => {
  const status = (ci: { state: 'passing' | 'failing' | 'pending'; sha: string } | null, head = 'h2', ahead = 0): RepoStatus => ({
    dir: '/u/a',
    checkedAt: '',
    git: {
      branch: 'main',
      tracking: 'origin/main',
      uncommitted: 0,
      ahead,
      behind: 0,
      commits: [{ hash: head, short: head, date: '', subject: '', author: '' }],
      remoteUrl: null,
    },
    gitError: null,
    github: { repo: 'me/a', prs: [], ci: ci && { ...ci, workflow: 'CI', url: '', at: '' } },
    githubError: null,
  });

  it('awaits CI while a run is in progress, or while the pushed commit has no run yet', () => {
    expect(awaitingCi(status({ state: 'pending', sha: 'h2' }))).toBe(true);
    expect(awaitingCi(status({ state: 'passing', sha: 'h1' }))).toBe(true); // pushed h2, newest run is for h1
    expect(awaitingCi(status({ state: 'passing', sha: 'h2' }))).toBe(false);
    expect(awaitingCi(status({ state: 'failing', sha: 'h1' }, 'h2', 1))).toBe(false); // h2 not pushed yet
    expect(awaitingCi(status(null))).toBe(false); // no runs and no workflow files
    const first = status(null);
    first.github!.workflows = true;
    expect(awaitingCi(first)).toBe(true); // workflow files, but GitHub hasn't listed the first run yet
  });

  it('rechecks a repo quickly until its run finishes, and gives up after a few tries', async () => {
    const answers = [status({ state: 'pending', sha: 'h2' }), status({ state: 'pending', sha: 'h2' }), status({ state: 'passing', sha: 'h2' })];
    let checks = 0;
    const poller = repoPoller({ repos: () => ['/u/a'], check: async () => answers[Math.min(checks++, answers.length - 1)], onChange: () => {}, ciMs: 5 });
    await poller.refresh('/u/a');
    await expect.poll(() => poller.get('/u/a')?.github?.ci?.state).toBe('passing');
    await new Promise((r) => setTimeout(r, 30));
    expect(checks).toBe(3); // no more checks once it passed

    let stuck = 0;
    const capped = repoPoller({ repos: () => ['/u/b'], check: async () => (stuck++, status({ state: 'pending', sha: 'h2' })), onChange: () => {}, ciMs: 2, ciTries: 3 });
    await capped.refresh('/u/b');
    await new Promise((r) => setTimeout(r, 40));
    expect(stuck).toBe(4); // the first check plus three quick rechecks
    capped.stop();
  });
});

describe('API', () => {
  function setup() {
    const dir = tmp();
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    fs.writeFileSync(t.projectsFile, `projects:\n  - slug: hub\n    name: Hub\n    repos: [/u/hub]\n`);
    t.store.reload();
    t.setRepoDirs(['/u/hub']);
    t.repoStates.set('/u/hub', {
      git: { branch: 'main', tracking: 'origin/main', uncommitted: 1, ahead: 2, behind: 0, commits: [], remoteUrl: 'https://github.com/me/hub.git' },
      gitError: null,
      github: { repo: 'me/hub', prs: [], ci: null },
      githubError: null,
    });
    return { t, app: createApp(t.deps) };
  }
  const hook = (event: string, cwd: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Token': 't0ken' },
    body: JSON.stringify({ session_id: 's1', hook_event_name: event, cwd }),
  });

  it('a Stop event checks that session’s repo straight away; other events do not', async () => {
    const { t, app } = setup();
    await app.request(`${HUB}/hooks/claude`, hook('SessionStart', '/u/hub'));
    expect(t.repoChecks).toEqual([]);
    await app.request(`${HUB}/hooks/claude`, hook('Stop', '/u/hub/src'));
    await expect.poll(() => t.repoChecks).toEqual(['/u/hub']);
    await app.request(`${HUB}/hooks/claude`, hook('Stop', '/u/elsewhere'));
    expect(t.repoChecks).toEqual(['/u/hub']);
  });

  it('projects carry their repos’ status, and Refresh needs the page token', async () => {
    const { app } = setup();
    let [p] = await (await app.request(`${HUB}/api/projects`, { headers: PAGE_GET })).json();
    expect(p.repoStatus).toEqual([null]); // not checked yet
    const refresh = (headers: Record<string, string>) => app.request(`${HUB}/api/projects/hub/repos/refresh`, { method: 'POST', headers });
    expect((await refresh({ 'X-Hub-Token': 'ui-t0ken' })).status).toBe(403); // no Origin
    const res = await refresh({ Origin: HUB, 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' });
    expect(res.status).toBe(200);
    [p] = await (await app.request(`${HUB}/api/projects`, { headers: PAGE_GET })).json();
    expect(p.repoStatus[0]).toMatchObject({ dir: '/u/hub', git: { branch: 'main', uncommitted: 1, ahead: 2 }, github: { repo: 'me/hub' } });
  });
});

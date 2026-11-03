// Phase 8: status rules, last activity, stale after 14 days, home page order and the timeline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTimeline, describeEvent, isStale, lastActivity, sortProjects, statusBadges, type ActivityEvent, type ActivityInput } from '../src/server/activity.ts';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { chats, links, sessions } from '../src/server/db/schema.ts';
import type { RepoStatus } from '../src/server/repos.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-')));
  dirs.push(d);
  return d;
};

const DAY = 86_400_000;
const at = (s: string) => new Date(s);

const repo = (over: { uncommitted?: number; ahead?: number; prs?: number; ci?: 'passing' | 'failing' | 'pending' | null; commits?: [string, string, string][] } = {}): RepoStatus => ({
  dir: '/u/r',
  checkedAt: '',
  git: {
    branch: 'main',
    tracking: 'origin/main',
    uncommitted: over.uncommitted ?? 0,
    ahead: over.ahead ?? 0,
    behind: 0,
    commits: (over.commits ?? []).map(([hash, date, subject]) => ({ hash, short: hash.slice(0, 7), date, subject, author: 'me' })),
    remoteUrl: 'https://github.com/me/r.git',
  },
  gitError: null,
  github: {
    repo: 'me/r',
    prs: Array.from({ length: over.prs ?? 0 }, (_, i) => ({ number: i + 1, title: 'PR', url: '', branch: 'b', draft: false, author: null, updatedAt: '', checks: 'none' as const })),
    ci: over.ci ? { state: over.ci, workflow: 'CI', url: 'https://github.com/me/r/actions/runs/1', at: '2026-11-03T14:31:00.000Z', sha: 'c2' } : null,
  },
  githubError: null,
});

const empty: ActivityInput = { sessions: [], chats: [], repos: [], files: [], links: [] };

describe('timeline', () => {
  it('merges every source newest first, groups files by hour and lists each commit once', () => {
    const r = repo({ ci: 'passing', commits: [['c2aaaaaaaa', '2026-11-03T14:30:00.000Z', 'Add CI'], ['c1aaaaaaaa', '2026-10-28T19:15:00.000Z', 'Toolkit notes']] });
    const events = buildTimeline({
      sessions: [
        { id: 's1', title: 'Add CI to card', state: 'ended', lastActiveAt: at('2026-11-03T14:00:00Z'), endedAt: at('2026-11-03T14:12:00Z'), resumeProblem: null },
        { id: 's2', title: null, state: 'running', lastActiveAt: at('2026-11-03T15:00:00Z'), endedAt: null, resumeProblem: 'No saved conversation' },
      ],
      chats: [{ id: 'ch1', title: 'Pricing ideas', lastActiveAt: at('2026-11-02T16:40:00Z') }],
      repos: [r, r], // the same repo listed twice still shows each commit once
      files: [
        { path: '/u/r/src/a.ts', rel: 'src/a.ts', mtime: '2026-11-03T13:58:00.000Z' },
        { path: '/u/r/src/b.ts', rel: 'src/b.ts', mtime: '2026-11-03T13:20:00.000Z' },
        { path: '/u/r/README.md', rel: 'README.md', mtime: '2026-11-03T12:59:00.000Z' },
      ],
      links: [{ url: 'https://github.com/me/r/pull/12', title: null, createdAt: at('2026-11-02T11:02:00Z') }],
    });
    expect(events.map((e) => `${e.at.slice(5, 16)} ${describeEvent(e)}`)).toEqual([
      '11-03T15:00 session (untitled) (running)',
      '11-03T14:31 CI passed',
      '11-03T14:31 CI passed',
      '11-03T14:30 commit "Add CI"',
      '11-03T14:12 session "Add CI to card"', // an ended session sits at its end time
      '11-03T13:58 2 files changed', // 13:20 and 13:58 share an hour; 12:59 doesn't
      '11-03T12:59 edited README.md',
      '11-02T16:40 chat "Pricing ideas"',
      '11-02T11:02 link https://github.com/me/r/pull/12',
      '10-28T19:15 commit "Toolkit notes"',
    ]);
    expect(events[0]).toMatchObject({ kind: 'session', reopenable: false });
    expect(events.find((e) => e.kind === 'files')).toMatchObject({ count: 2, names: ['src/a.ts', 'src/b.ts'], path: '/u/r/src/a.ts' });
    expect(events.find((e) => e.kind === 'commit')).toMatchObject({ url: 'https://github.com/me/r/commit/c2aaaaaaaa' });
  });

  it('last activity is the newest thing you did; a CI result never counts', () => {
    const events = buildTimeline({ ...empty, repos: [repo({ ci: 'failing', commits: [['c1', '2026-11-01T10:00:00.000Z', 'Fix']] })] });
    expect(events[0].kind).toBe('ci');
    expect(lastActivity(events)).toMatchObject({ kind: 'commit', title: 'Fix' });
    expect(lastActivity(buildTimeline(empty))).toBeNull();
  });

  it('stale after 14 days without activity; a project with none at all is not stale', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const last = (daysAgo: number): ActivityEvent => ({ kind: 'chat', at: new Date(now - daysAgo * DAY).toISOString(), title: null, chatId: 'c' });
    expect(isStale(last(13.9), now)).toBe(false);
    expect(isStale(last(14), now)).toBe(true);
    expect(isStale(null, now)).toBe(false);
  });
});

describe('status', () => {
  it('badges come in priority order and add up across repos', () => {
    const p = { sessions: [{ state: 'ended' }, { state: 'running' }], repoStatus: [repo({ uncommitted: 2, ahead: 1, prs: 1, ci: 'failing' }), repo({ uncommitted: 1, prs: 1, ci: 'passing' }), null] };
    expect(statusBadges(p, true)).toEqual([
      { id: 'running', label: 'running' },
      { id: 'ci-failing', label: 'CI failing' },
      { id: 'prs', label: '2 PRs waiting' },
      { id: 'uncommitted', label: '3 uncommitted' },
      { id: 'to-push', label: '1 to push' },
      { id: 'stale', label: 'stale' },
    ]);
    expect(statusBadges({ sessions: [{ state: 'ended' }], repoStatus: [repo({ ci: 'pending', prs: 1 })] }, false)).toEqual([{ id: 'prs', label: '1 PR waiting' }]);
    expect(statusBadges({ sessions: [], repoStatus: [] }, false)).toEqual([]);
  });

  it('home page order: running first, then newest activity, then name', () => {
    const p = (name: string, running = false) => ({ name, slug: name.toLowerCase(), sessions: running ? [{ state: 'running' }] : [] });
    const act = (iso: string | null) => ({ last: iso ? ({ kind: 'chat', at: iso, title: null, chatId: 'x' } as const) : null, stale: false });
    const sorted = sortProjects(
      [p('Alpha'), p('Beta'), p('Gamma', true), p('Delta'), p('Epsilon')],
      { alpha: act('2026-10-01T00:00:00Z'), beta: act('2026-11-02T00:00:00Z'), gamma: act('2026-09-01T00:00:00Z'), delta: act(null) },
      (x) => x.slug,
    );
    expect(sorted.map((x) => x.name)).toEqual(['Gamma', 'Beta', 'Alpha', 'Delta', 'Epsilon']);
  });
});

describe('API', () => {
  async function until<T>(get: () => T, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('the home page gets last activity and stale per project; a project page gets its own timeline', async () => {
    const dir = tmp();
    for (const f of ['kratos', 'radar', 'hub']) fs.mkdirSync(path.join(dir, f));
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    cleanups.push(() => t.files.close());
    fs.writeFileSync(
      t.projectsFile,
      `projects:\n  - slug: kratos\n    name: Kratos\n    folders: [${dir}/kratos]\n  - slug: radar\n    name: Radar\n    folders: [${dir}/radar]\n  - slug: hub\n    name: Hub\n    repos: [${dir}/hub]\n`,
    );
    t.store.reload();
    const old = new Date(Date.now() - 20 * DAY);
    const recent = new Date(Date.now() - 60_000);
    db.insert(sessions).values({ id: 'k1', projectSlug: 'kratos', cwd: `${dir}/kratos`, state: 'ended', resumable: true, lastActiveAt: old, endedAt: old }).run();
    // Never saved a conversation: not listed, so it is not activity.
    db.insert(sessions).values({ id: 'k2', projectSlug: 'kratos', cwd: `${dir}/kratos`, state: 'ended', resumable: false, lastActiveAt: recent, endedAt: recent }).run();
    db.insert(chats).values({ id: 'r1', title: 'Radar chat', projectSlug: 'radar', source: 'extension', createdAt: recent, lastActiveAt: recent }).run();
    db.insert(links).values({ url: 'https://example.com/k', key: 'example.com/k', projectSlug: 'kratos', filedBy: 'manual', source: 'paste', createdAt: old, updatedAt: old }).run();
    t.setRepoDirs([`${dir}/hub`]);
    t.repoStates.set(`${dir}/hub`, repo({ ci: 'passing', commits: [['h1', new Date(Date.now() - 2 * DAY).toISOString(), 'Hub commit']] }));
    await t.repos.refreshAll();
    fs.writeFileSync(path.join(dir, 'radar/main.py'), 'x');
    t.setFileRoots([{ dir: `${dir}/kratos`, repo: false }, { dir: `${dir}/radar`, repo: false }]);
    t.files.sync();
    await until(() => t.files.recent(() => true).length === 1);

    const app = createApp(t.deps);
    const get = async (url: string) => {
      const res = await app.request(`${HUB}${url}`, { headers: PAGE_GET });
      return { status: res.status, body: await res.json() };
    };
    const { body: activity } = await get('/api/activity');
    expect(activity.kratos).toMatchObject({ stale: true, last: { kind: 'session', sessionId: 'k1' } });
    expect(activity.hub).toMatchObject({ stale: false, last: { kind: 'commit', title: 'Hub commit' } });
    expect(['chat', 'files']).toContain(activity.radar.last.kind);
    expect(activity.radar.stale).toBe(false);

    const { body: timeline } = await get('/api/projects/radar/activity');
    expect(timeline.total).toBe(2);
    expect(timeline.events.map((e: ActivityEvent) => e.kind).sort()).toEqual(['chat', 'files']);
    expect(timeline.events.find((e: ActivityEvent) => e.kind === 'files')).toMatchObject({ names: ['main.py'] });
    expect((await get('/api/projects/kratos/activity?limit=1')).body).toMatchObject({ total: 2, events: [{ kind: 'session' }] });
    expect((await get('/api/projects/nope/activity')).status).toBe(404);

    // Both need the page token.
    expect((await app.request(`${HUB}/api/activity`)).status).toBe(403);
  });
});

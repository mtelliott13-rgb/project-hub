// Phase 9: the read-only MCP server and the /agent routes behind it.
// The tool list and every field the tools return are pinned here, so exposing
// anything more fails a test until it's reviewed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { agoText } from '../src/server/agent-routes.ts';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import { ALLOW_RULES, withAllowRules, withDesktopEntry, withoutAllowRules, withoutDesktopEntry } from '../src/server/mcp-config.ts';
import { createMcpServer, HUB_DOWN, hubFetch } from '../src/server/mcp-server.ts';
import type { RepoStatus } from '../src/server/repos.ts';
import { AGENT_TOKEN, HUB, testDeps } from './helpers.ts';

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

function setup() {
  const dir = tmp();
  for (const f of ['radar', 'career', 'old']) fs.mkdirSync(path.join(dir, f));
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db);
  cleanups.push(() => t.files.close());
  fs.writeFileSync(
    t.projectsFile,
    [
      'projects:',
      '  - slug: radar',
      '    name: Meme Radar',
      `    repos: [${dir}/radar]`,
      '  - slug: career',
      '    name: Career HQ',
      `    folders: [${dir}/career]`,
      '  - slug: old',
      '    name: Old Thing',
      `    folders: [${dir}/old]`,
      '    archived: true',
      '',
    ].join('\n'),
  );
  t.store.reload();
  fs.writeFileSync(
    path.join(dir, 'career/toolkit.yaml'),
    [
      'items:',
      '  - name: Portfolio site',
      '    category: Presence',
      '    url: https://example.com/p',
      '    cost: free',
      '    why: Shows the work',
      '    target: 2020-01-01',
      '    status: in progress',
      '  - name: Resume',
      '    category: Docs',
      '    status: done',
      '  - name: Podcast',
      '    category: Presence',
      '    status: parked',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    t.deps.ideasFile,
    '# Ideas\n\n- [ ] Show rug-pull score · radar · added 2026-11-01\n- [x] Start/Stop buttons · radar · added 2026-10-20 · done 2026-10-21\n- [ ] Dark mode toggle · hub · added 2026-11-02\n',
  );
  const recent = new Date(Date.now() - 5 * 60_000);
  db.insert(sessions).values({ id: 'r1', projectSlug: 'radar', cwd: `${dir}/radar`, title: 'RugCheck retry loop', gitBranch: 'main', state: 'running', resumable: true, lastActiveAt: recent }).run();
  db.insert(sessions).values({ id: 'r0', projectSlug: 'radar', cwd: `${dir}/gone`, title: 'Folder since deleted', state: 'ended', resumable: true, lastActiveAt: new Date(Date.now() - DAY), endedAt: new Date(Date.now() - DAY) }).run();
  db.insert(sessions).values({ id: 'c1', projectSlug: 'career', cwd: `${dir}/career`, title: 'Career command center', state: 'ended', resumable: true, lastActiveAt: new Date(Date.now() - 20 * DAY), endedAt: new Date(Date.now() - 20 * DAY) }).run();
  db.insert(sessions).values({ id: 'c2', projectSlug: 'career', cwd: `${dir}/career`, title: null, state: 'ended', resumable: false, lastActiveAt: new Date(), endedAt: new Date() }).run();
  db.insert(sessions).values({ id: 'u1', projectSlug: null, cwd: `${dir}`, title: 'Unfiled', state: 'ended', resumable: true, lastActiveAt: new Date() }).run();
  const radarRepo: Omit<RepoStatus, 'dir' | 'checkedAt'> = {
    git: { branch: 'main', tracking: 'origin/main', uncommitted: 3, ahead: 1, behind: 0, commits: [{ hash: 'abc1234567', short: 'abc1234', date: new Date(Date.now() - 2 * DAY).toISOString(), subject: 'Retry RugCheck', author: 'me' }], remoteUrl: 'https://github.com/me/radar.git' },
    gitError: null,
    github: {
      repo: 'me/radar',
      prs: [{ number: 4, title: 'Token table columns', url: 'https://github.com/me/radar/pull/4', branch: 'cols', draft: false, author: 'me', updatedAt: '', checks: 'failing' }],
      ci: { state: 'failing', workflow: 'CI', url: 'https://github.com/me/radar/actions/runs/9', at: new Date(Date.now() - DAY).toISOString(), sha: 'abc1234567' },
    },
    githubError: null,
  };
  t.setRepoDirs([`${dir}/radar`]);
  t.repoStates.set(`${dir}/radar`, radarRepo);
  const app = createApp({ ...t.deps, home: dir });
  const get = async (url: string, headers: Record<string, string> = { 'X-Agent-Token': AGENT_TOKEN }, method = 'GET') => {
    const res = await app.request(`${HUB}${url}`, { method, headers });
    return { status: res.status, body: await res.json() };
  };
  return { dir, db, t, app, get };
}

const keys = (o: object) => Object.keys(o).sort();

describe('/agent routes', () => {
  it('answer only GETs with the agent token, and never a browser', async () => {
    const { get } = setup();
    expect((await get('/agent/v1/projects', {})).status).toBe(401);
    expect((await get('/agent/v1/projects', { 'X-Agent-Token': 'ui-t0ken' })).status).toBe(401); // the page's token
    expect((await get('/agent/v1/projects', { 'X-Agent-Token': 't0ken' })).status).toBe(401); // the hook token
    expect((await get('/agent/v1/projects', { 'X-Agent-Token': 'ui-t0ken', 'X-Hub-Token': 'ui-t0ken' })).status).toBe(401);
    expect((await get('/agent/v1/projects', { 'X-Agent-Token': AGENT_TOKEN, Origin: HUB })).status).toBe(403);
    expect((await get('/agent/v1/projects', { 'X-Agent-Token': AGENT_TOKEN, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/agent/v1/projects', { 'X-Agent-Token': AGENT_TOKEN, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await get('/agent/v1/projects', { 'X-Agent-Token': AGENT_TOKEN }, method)).status).toBe(405);
    // The agent token opens nothing outside /agent.
    expect((await get('/api/projects', { 'X-Agent-Token': AGENT_TOKEN })).status).toBe(403);
    expect((await get('/api/projects', { 'X-Hub-Token': AGENT_TOKEN })).status).toBe(403);
    expect((await get('/agent/v1/projects')).status).toBe(200);
  });

  it('a request for another host is refused (DNS rebinding)', async () => {
    const { app } = setup();
    const res = await app.request('http://evil.example:4747/agent/v1/projects', { headers: { 'X-Agent-Token': AGENT_TOKEN } });
    expect(res.status).toBe(421);
  });

  it('list_projects: badges, last activity, toolkit and open ideas, archived only on request', async () => {
    const { t, get } = setup();
    await t.repos.refreshAll();
    const { body } = await get('/agent/v1/projects');
    expect(keys(body)).toEqual(['now', 'projects']);
    expect(body.projects.map((p: { slug: string }) => p.slug)).toEqual(['radar', 'career']);
    const [radar, career] = body.projects;
    expect(keys(radar)).toEqual(['archived', 'badges', 'lastActivity', 'name', 'openIdeas', 'runningSessions', 'slug', 'stale', 'toolkit']);
    expect(radar).toMatchObject({ name: 'Meme Radar', badges: ['running', 'CI failing', '1 PR waiting', '3 uncommitted', '1 to push'], runningSessions: 1, stale: false, toolkit: null, openIdeas: 1 });
    expect(radar.lastActivity).toMatchObject({ kind: 'session', what: 'session "RugCheck retry loop" (running)', ago: '5m ago' });
    expect(keys(radar.lastActivity)).toEqual(['ago', 'at', 'kind', 'what']);
    // Career's newest listed session is 20 days old (c2 never saved a conversation): stale.
    expect(career).toMatchObject({ badges: ['stale'], stale: true, toolkit: '1 of 2 done', openIdeas: 0 });
    expect((await get('/agent/v1/projects?archived=1')).body.projects.map((p: { slug: string }) => p.slug)).toEqual(['radar', 'career', 'old']);
  });

  it('get_project: repos, sessions, toolkit, ideas and timeline, with home shortened to ~', async () => {
    const { t, get } = setup();
    await t.repos.refreshAll();
    const { status, body } = await get('/agent/v1/projects/radar');
    expect(status).toBe(200);
    expect(keys(body)).toEqual([
      'archived', 'badges', 'folders', 'ideas', 'lastActivity', 'name', 'now', 'openIdeas', 'recentSessions', 'repos', 'runningSessions', 'slug', 'stale', 'timeline', 'toolkit', 'toolkitDetail',
    ]);
    expect(body.folders).toEqual(['~/radar']);
    expect(body.repos).toHaveLength(1);
    expect(keys(body.repos[0])).toEqual(['ahead', 'behind', 'branch', 'checked', 'ci', 'error', 'github', 'openPrs', 'path', 'uncommitted']);
    expect(body.repos[0]).toMatchObject({ path: '~/radar', github: 'me/radar', branch: 'main', uncommitted: 3, ahead: 1, behind: 0, error: null, ci: { result: 'failing', workflow: 'CI' } });
    expect(body.repos[0].openPrs).toEqual([{ number: 4, title: 'Token table columns', url: 'https://github.com/me/radar/pull/4', draft: false, checks: 'failing' }]);
    // r0's folder is gone, so it isn't listed (it can't be reopened and isn't running).
    expect(body.recentSessions.map((s: { id: string }) => s.id)).toEqual(['r1']);
    expect(keys(body.recentSessions[0])).toEqual(['ago', 'branch', 'canResume', 'folder', 'id', 'lastActive', 'project', 'projectName', 'resume', 'state', 'title']);
    expect(body.recentSessions[0]).toMatchObject({ folder: '~/radar', canResume: true, resume: 'claude --resume r1', state: 'running', projectName: 'Meme Radar' });
    expect(body.ideas).toEqual([{ text: 'Show rug-pull score', scope: 'radar', added: '2026-11-01', done: false, doneOn: null }]);
    expect(body.toolkitDetail).toBeNull();
    expect(body.timeline.map((e: { kind: string }) => e.kind)).toEqual(['session', 'ci', 'commit']);
    expect(body.timeline[2]).toEqual(expect.objectContaining({ what: 'commit "Retry RugCheck"', url: 'https://github.com/me/radar/commit/abc1234567' }));

    const career = (await get('/agent/v1/projects/career')).body;
    expect(career.toolkitDetail).toEqual({
      file: '~/career/toolkit.yaml',
      byStatus: { 'not started': 0, 'in progress': 1, done: 1, parked: 1 },
      inProgress: ['Portfolio site'],
      overdue: [{ name: 'Portfolio site', target: '2020-01-01' }],
    });
    expect((await get('/agent/v1/projects/nope')).status).toBe(404);
  });

  it('recent_sessions: filed sessions only, newest first, limited', async () => {
    const { get } = setup();
    const { body } = await get('/agent/v1/sessions');
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['r1', 'c1']);
    expect((await get('/agent/v1/sessions?slug=career')).body.sessions.map((s: { id: string }) => s.id)).toEqual(['c1']);
    expect((await get('/agent/v1/sessions?limit=1')).body.sessions).toHaveLength(1);
    expect((await get('/agent/v1/sessions?limit=999')).body.sessions).toHaveLength(2); // capped at 50
    expect((await get('/agent/v1/sessions?slug=nope')).status).toBe(404);
  });

  it('list_ideas and get_toolkit', async () => {
    const { get } = setup();
    expect((await get('/agent/v1/ideas')).body.ideas.map((i: { text: string }) => i.text)).toEqual(['Show rug-pull score', 'Dark mode toggle']);
    expect((await get('/agent/v1/ideas?scope=radar&done=1')).body.ideas.map((i: { text: string }) => i.text)).toEqual(['Show rug-pull score', 'Start/Stop buttons']);
    const { body } = await get('/agent/v1/projects/career/toolkit');
    expect(keys(body)).toEqual(['done', 'file', 'items', 'problems', 'project', 'total']);
    expect(body).toMatchObject({ project: 'career', done: 1, total: 2, file: '~/career/toolkit.yaml' });
    expect(keys(body.items[0])).toEqual(['category', 'cost', 'name', 'notes', 'overdue', 'status', 'target', 'url', 'why']);
    expect(body.items.map((i: { name: string; status: string; overdue: boolean }) => [i.name, i.status, i.overdue])).toEqual([
      ['Portfolio site', 'in progress', true],
      ['Resume', 'done', false],
      ['Podcast', 'parked', false],
    ]);
    expect((await get('/agent/v1/projects/radar/toolkit')).status).toBe(404);
  });

  it('agoText', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(agoText('2026-11-04T11:59:30Z', now)).toBe('just now');
    expect(agoText('2026-11-04T11:56:00Z', now)).toBe('4m ago');
    expect(agoText('2026-11-04T09:00:00Z', now)).toBe('3h ago');
    expect(agoText('2026-10-23T12:00:00Z', now)).toBe('12d ago');
  });
});

describe('MCP server', () => {
  async function connect(get = setup()) {
    const fetcher = ((url: string, init?: RequestInit) => get.app.request(url, init)) as typeof fetch;
    const server = createMcpServer(hubFetch(HUB, AGENT_TOKEN, fetcher));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(() => void client.close());
    return { client, ...get };
  }
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

  it('offers exactly five tools, all read-only', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_projects', 'get_project', 'recent_sessions', 'list_ideas', 'get_toolkit']);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(Object.keys(tools.find((t) => t.name === 'recent_sessions')!.inputSchema.properties ?? {})).toEqual(['slug', 'limit']);
  });

  it('each tool returns what its /agent route returns', async () => {
    const { client, t } = await connect();
    await t.repos.refreshAll();
    const projects = JSON.parse(text(await client.callTool({ name: 'list_projects', arguments: {} })));
    expect(projects.projects.map((p: { slug: string }) => p.slug)).toEqual(['radar', 'career']);
    const archived = JSON.parse(text(await client.callTool({ name: 'list_projects', arguments: { include_archived: true } })));
    expect(archived.projects).toHaveLength(3);
    expect(JSON.parse(text(await client.callTool({ name: 'get_project', arguments: { slug: 'radar' } }))).badges).toContain('CI failing');
    expect(JSON.parse(text(await client.callTool({ name: 'recent_sessions', arguments: { slug: 'career', limit: 5 } }))).sessions).toHaveLength(1);
    expect(JSON.parse(text(await client.callTool({ name: 'list_ideas', arguments: { scope: 'hub' } }))).ideas).toHaveLength(1);
    expect(JSON.parse(text(await client.callTool({ name: 'get_toolkit', arguments: { slug: 'career' } }))).done).toBe(1);
  });

  it('bad arguments and unknown projects come back as tool errors', async () => {
    const { client } = await connect();
    const missing = await client.callTool({ name: 'get_project', arguments: { slug: 'nope' } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No project "nope"');
    const bad = await client.callTool({ name: 'get_project', arguments: { slug: '../api/projects' } });
    expect(bad.isError).toBe(true);
  });

  it('says so plainly when the hub is down', async () => {
    const server = createMcpServer(hubFetch(HUB, AGENT_TOKEN, (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(HUB_DOWN);
    await client.close();
  });
});

describe('registering', () => {
  it('the desktop entry is added and removed without touching anything else', () => {
    const config = { preferences: { a: 1 }, mcpServers: { other: { command: 'x' } } };
    const added = withDesktopEntry(config, '/Users/me');
    expect(added).toEqual({
      preferences: { a: 1 },
      mcpServers: {
        other: { command: 'x' },
        'project-hub': { command: '/Users/me/.local/node/bin/node', args: ['--disable-warning=ExperimentalWarning', '/Users/me/project-hub/scripts/mcp.ts'] },
      },
    });
    expect(withoutDesktopEntry(added)).toEqual(config);
    expect(withoutDesktopEntry(withDesktopEntry({ preferences: {} }, '/Users/me'))).toEqual({ preferences: {} }); // no empty mcpServers left behind
    expect(withoutDesktopEntry({ preferences: {} })).toEqual({ preferences: {} });
  });

  it('allow rules name each of the five tools, are added once and removed alone', () => {
    expect(ALLOW_RULES).toEqual([
      'mcp__project-hub__list_projects',
      'mcp__project-hub__get_project',
      'mcp__project-hub__recent_sessions',
      'mcp__project-hub__list_ideas',
      'mcp__project-hub__get_toolkit',
    ]);
    const settings = { hooks: { Stop: [] }, permissions: { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] } };
    const added = withAllowRules(settings);
    expect(withAllowRules(added)).toEqual(added);
    expect((added.permissions as { allow: string[] }).allow).toEqual(['Bash(ls:*)', ...ALLOW_RULES]);
    expect(withoutAllowRules(added)).toEqual(settings);
    expect(withAllowRules({})).toEqual({ permissions: { allow: ALLOW_RULES } });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, injectToken } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb, syncProjects } from '../src/server/db/index.ts';
import { sessions, type Project, type Session } from '../src/server/db/schema.ts';
import {
  commandFile,
  describePlan,
  launchRequestSchema,
  planLaunch,
  shellQuote,
  type LaunchLookup,
  type LaunchRequest,
} from '../src/server/launcher.ts';
import { HUB, testDeps } from './helpers.ts';

const SID = '0b5c6a0e-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const CHAT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const PROJ = '0f6c1c1e-0000-4000-8000-000000000000';

const project = (over: Partial<Project> = {}): Project => ({
  slug: 'acme',
  name: 'Acme',
  repos: ['/u/code/acme', '/u/code/acme-api'],
  folders: ['/u/Documents/Acme'],
  github: [],
  claudeProject: `https://claude.ai/project/${PROJ}`,
  keywords: [],
  pinnedSessions: [],
  colour: null,
  pinned: false,
  archived: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const session = { id: SID, cwd: "/u/code/acme/.claude/worktrees/it's here", resumable: true } as Session;

const lookup = (over: Partial<LaunchLookup> = {}): LaunchLookup => ({
  session: (id) => (id === SID ? session : undefined),
  project: (slug) => (slug === 'acme' ? project() : undefined),
  claudeDesktopInstalled: true,
  exists: () => true,
  ...over,
});

const command = (req: LaunchRequest, over?: Partial<LaunchLookup>) => describePlan(planLaunch(req, lookup(over)));

describe('launch command building', () => {
  it('builds the exact command for every kind', () => {
    expect(command({ kind: 'session', sessionId: SID })).toBe(
      `cd '/u/code/acme/.claude/worktrees/it'\\''s here' && claude --resume ${SID}   (in a new Terminal window)`,
    );
    expect(command({ kind: 'desktop', sessionId: SID })).toBe(
      `cd '/u/code/acme/.claude/worktrees/it'\\''s here' && claude --desktop --resume ${SID}`,
    );
    expect(command({ kind: 'new-session', slug: 'acme' })).toBe(`open 'claude-cli://open?cwd=%2Fu%2Fcode%2Facme'`);
    expect(command({ kind: 'chat', chatId: CHAT })).toBe(`open claude://claude.ai/chat/${CHAT}`);
    expect(command({ kind: 'chat', chatId: CHAT, in: 'browser' })).toBe(`open https://claude.ai/chat/${CHAT}`);
    expect(command({ kind: 'claude-project', slug: 'acme' })).toBe(`open claude://claude.ai/project/${PROJ}`);
    expect(command({ kind: 'editor', slug: 'acme' })).toBe(`open -a 'Visual Studio Code' /u/code/acme`);
    expect(command({ kind: 'from-pr', slug: 'acme', pr: 42 })).toBe(
      `cd /u/code/acme && claude --from-pr 42   (in a new Terminal window)`,
    );
  });

  it('opens chats in the browser when the desktop app is missing', () => {
    expect(command({ kind: 'chat', chatId: CHAT }, { claudeDesktopInstalled: false })).toBe(
      `open https://claude.ai/chat/${CHAT}`,
    );
  });

  it('only uses paths the project lists', () => {
    expect(command({ kind: 'editor', slug: 'acme', path: '/u/Documents/Acme' })).toBe(
      `open -a 'Visual Studio Code' /u/Documents/Acme`,
    );
    expect(command({ kind: 'new-session', slug: 'acme', path: '/u/code/acme-api' })).toContain('acme-api');
    expect(() => command({ kind: 'editor', slug: 'acme', path: '/etc' })).toThrow(/not one of this project's/);
    // Folders are for the editor only; new sessions and PRs need a repo.
    expect(() => command({ kind: 'from-pr', slug: 'acme', pr: 1, path: '/u/Documents/Acme' })).toThrow(/repos/);
  });

  it('refuses unknown ids, missing folders and missing links', () => {
    expect(() => command({ kind: 'session', sessionId: CHAT })).toThrow(/Unknown session/);
    expect(() => command({ kind: 'editor', slug: 'nope' })).toThrow(/Unknown project/);
    expect(() => command({ kind: 'session', sessionId: SID }, { exists: () => false })).toThrow(/no longer exists/);
    const bare = lookup({ project: () => project({ claudeProject: null, repos: [] }) });
    expect(() => planLaunch({ kind: 'claude-project', slug: 'acme' }, bare)).toThrow(/claude_project/);
    expect(() => planLaunch({ kind: 'new-session', slug: 'acme' }, bare)).toThrow(/no repos/);
  });

  it('rejects ids that are not UUIDs, so nothing odd reaches a shell', () => {
    expect(launchRequestSchema.safeParse({ kind: 'session', sessionId: '$(rm -rf ~)' }).success).toBe(false);
    expect(launchRequestSchema.safeParse({ kind: 'from-pr', slug: 'acme', pr: '1; ls' }).success).toBe(false);
    expect(launchRequestSchema.safeParse({ kind: 'shell', cmd: 'ls' }).success).toBe(false);
  });

  it('quotes for the shell', () => {
    expect(shellQuote('/u/plain-path_1.2')).toBe('/u/plain-path_1.2');
    expect(shellQuote('a b')).toBe(`'a b'`);
    expect(shellQuote(`$HOME;"x"'y'`)).toBe(`'$HOME;"x"'\\''y'\\'''`);
  });

  it('writes a .command file that removes itself, then runs the command', () => {
    expect(commandFile({ cwd: '/u/my repo', argv: ['claude', '--resume', SID] })).toBe(
      `#!/bin/sh\n# Written by Project Hub for one launch; removes itself when it runs.\nrm -f -- "$0"\ncd '/u/my repo' || exit 1\nexec claude --resume ${SID}\n`,
    );
  });
});

describe('POST /api/launch', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
    dirs.push(dir);
    const repo = path.join(dir, 'acme');
    fs.mkdirSync(repo);
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    syncProjects(db, [{ slug: 'acme', name: 'Acme', repos: [repo], folders: [], github: [], keywords: [], sessions: [], archived: false }]);
    db.insert(sessions).values({ id: SID, projectSlug: 'acme', cwd: repo, state: 'ended', resumable: true, lastActiveAt: new Date() }).run();
    const webDir = path.join(dir, 'web');
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html><head><title>Hub</title></head><body></body></html>');
    const { deps, launched } = testDeps(db);
    const app = createApp({ ...deps, webDir });
    const good = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    const launch = (headers: Record<string, string | undefined>, body: unknown = { kind: 'session', sessionId: SID }, url = `${HUB}/api/launch`) =>
      app.request(url, {
        method: 'POST',
        headers: Object.fromEntries(Object.entries({ ...good, ...headers }).filter(([, v]) => v !== undefined)) as Record<string, string>,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    return { app, launch, launched, repo };
  }

  it('launches from the hub page with the token', async () => {
    const { launch, launched, repo } = setup();
    const res = await launch({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, command: `cd ${repo} && claude --resume ${SID}   (in a new Terminal window)` });
    expect(launched).toEqual([{ via: 'terminal', cwd: repo, argv: ['claude', '--resume', SID] }]);
  });

  it('also accepts the page at localhost:4747', async () => {
    const { launch, launched } = setup();
    expect((await launch({ Origin: 'http://localhost:4747' }, undefined, 'http://localhost:4747/api/launch')).status).toBe(200);
    expect(launched).toHaveLength(1);
  });

  it('dry run shows the command without launching', async () => {
    const { launch, launched } = setup();
    const res = await launch({}, { kind: 'editor', slug: 'acme', dryRun: true });
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, command: expect.stringContaining("open -a 'Visual Studio Code'") });
    expect(launched).toEqual([]);
  });

  it.each([
    ['no Origin (curl, scripts)', { Origin: undefined }],
    ['another site', { Origin: 'https://evil.example' }],
    ['another local port', { Origin: 'http://127.0.0.1:3000' }],
    ['a null origin (sandboxed frame, file://)', { Origin: 'null' }],
    ['a cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }],
    ['a same-site but different-origin fetch', { 'Sec-Fetch-Site': 'same-site' }],
    ['no token', { 'X-Hub-Token': undefined }],
    ['a wrong token', { 'X-Hub-Token': 'ui-t0kem' }],
    ['the hook token instead of the page token', { 'X-Hub-Token': 't0ken' }],
    ['a form post (text/plain, no preflight)', { 'Content-Type': 'text/plain' }],
  ])('refuses %s with 403 and launches nothing', async (_, headers) => {
    const { launch, launched } = setup();
    const res = await launch(headers);
    expect(res.status).toBe(403);
    expect(launched).toEqual([]);
  });

  it('refuses a DNS-rebinding request (right IP, foreign Host) before anything else', async () => {
    const { launch, launched, app } = setup();
    const rebound = { Host: 'evil.example:4747', Origin: 'http://evil.example:4747' };
    expect((await launch(rebound, undefined, 'http://evil.example:4747/api/launch')).status).toBe(421);
    // The page that carries the token is refused too.
    expect((await app.request('http://evil.example:4747/')).status).toBe(421);
    expect(launched).toEqual([]);
  });

  it('refuses GET and bad bodies', async () => {
    const { app, launch, launched } = setup();
    expect((await app.request(`${HUB}/api/launch`, { headers: { 'X-Hub-Token': 'ui-t0ken' } })).status).toBe(404);
    expect((await launch({}, '{not json')).status).toBe(400);
    expect((await launch({}, { kind: 'session', sessionId: 'x' })).status).toBe(400);
    expect((await launch({}, { kind: 'editor', slug: 'acme', path: '/etc' })).status).toBe(400);
    expect((await launch({}, { kind: 'editor', slug: 'nope' })).status).toBe(404);
    expect(launched).toEqual([]);
  });

  it('serves the page with the token, uncached and unframeable', async () => {
    const { app } = setup();
    for (const p of ['/', '/index.html', '/some/route']) {
      const res = await app.request(`${HUB}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<meta name="hub-token" content="ui-t0ken" />');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    }
  });

  it('injects the token before </head>', () => {
    expect(injectToken('<head></head>', 'abc')).toBe('<head>    <meta name="hub-token" content="abc" />\n  </head>');
  });
});

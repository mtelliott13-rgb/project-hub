// Phase 6: recent files, links with domain and path rules, and the Inbox.
// File tests use real throwaway folders and git repos; nothing outside the
// temp folder is watched or written.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { listAllProjects, openDb } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import { fileWatcher, ignoredByName } from '../src/server/files.ts';
import { tooBroad } from '../src/server/folders.ts';
import { fileInbox, matchLink, parseLink, ruleChoices } from '../src/server/links.ts';
import { addFolder, pinSession } from '../src/server/projects-file.ts';
import { parseProjects } from '../src/server/projects.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const tmp = () => {
  // realpath: macOS's /var is a link to /private/var, and watchers report real paths.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-')));
  dirs.push(d);
  return d;
};

async function until<T>(get: () => T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const yaml = (dir: string) => `projects:
  - slug: kratos
    name: Kratos
    folders: [${dir}/kratos]

  - slug: radar
    name: Meme Radar
    repos: [${dir}/radar]
    github: [someone/meme-radar]
    claude_project: https://claude.ai/project/0b6a6f0e-1111-4222-8333-944455556666
`;

function setup() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'kratos'));
  fs.mkdirSync(path.join(dir, 'radar'));
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db);
  cleanups.push(() => t.files.close());
  fs.writeFileSync(t.projectsFile, yaml(dir));
  t.store.reload();
  // The temp folder stands in for the home folder, so project folders can be added inside it.
  const apps = new Map<string, ReturnType<typeof createApp>>();
  const appFor = (home: string) => apps.get(home) ?? apps.set(home, createApp({ ...t.deps, home })).get(home)!;
  const app = appFor(dir);
  const page = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
  const callAs = async (home: string, method: string, url: string, body?: unknown) => {
    const res = await appFor(home).request(`${HUB}${url}`, { method, headers: method === 'GET' ? PAGE_GET : page, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const call = (method: string, url: string, body?: unknown) => callAs(dir, method, url, body);
  return { dir, db, t, app, call, callAs };
}

describe('links: parsing and matching', () => {
  it('keeps one copy per page: www, scheme and #fragment are ignored, http(s) only', () => {
    const a = parseLink('https://www.Docs.Example.com/Document/D/AbC/?x=1#heading');
    expect(a).toMatchObject({ host: 'docs.example.com', path: '/document/d/abc', key: 'docs.example.com/Document/D/AbC?x=1' });
    expect(parseLink('http://docs.example.com/Document/D/AbC?x=1').key).toBe(a.key);
    expect(() => parseLink('javascript:alert(1)')).toThrow(/Only http and https/);
    expect(() => parseLink('not a url')).toThrow(/Not a link/);
  });

  it('the most specific rule wins, on whole path segments', () => {
    const at = (n: number) => new Date(n);
    const rules = [
      { id: 1, projectSlug: 'a', host: 'example.com', pathPrefix: '', createdAt: at(1) },
      { id: 2, projectSlug: 'b', host: 'example.com', pathPrefix: '/design', createdAt: at(2) },
      { id: 3, projectSlug: 'c', host: 'docs.example.com', pathPrefix: '', createdAt: at(3) },
    ];
    const m = (url: string) => matchLink(parseLink(url), [], rules)?.slug ?? null;
    expect(m('https://example.com/blog/post')).toBe('a');
    expect(m('https://example.com/design/one')).toBe('b');
    expect(m('https://example.com/designs/one')).toBe('a'); // not the /design segment
    expect(m('https://api.example.com/x')).toBe('a'); // subdomain of a domain rule
    expect(m('https://docs.example.com/design/one')).toBe('c'); // exact host beats parent domain + path
    expect(m('https://other.com/')).toBeNull();
  });

  it("a project's GitHub repo and Claude Project file their links; a saved rule beats them on a tie", () => {
    const projects = [{ slug: 'radar', github: ['someone/Meme-Radar'], claudeProject: 'https://claude.ai/project/0b6a6f0e-1111-4222-8333-944455556666' }];
    expect(matchLink(parseLink('https://github.com/someone/meme-radar/pull/3'), projects, [])).toEqual({ slug: 'radar', filedBy: 'github', ruleId: null });
    expect(matchLink(parseLink('https://github.com/someone/meme-radar-two'), projects, [])).toBeNull();
    expect(matchLink(parseLink('https://claude.ai/project/0b6a6f0e-1111-4222-8333-944455556666'), projects, [])?.filedBy).toBe('claude-project');
    const rule = { id: 9, projectSlug: 'other', host: 'github.com', pathPrefix: '/someone/meme-radar', createdAt: new Date() };
    expect(matchLink(parseLink('https://github.com/someone/meme-radar'), projects, [rule])?.slug).toBe('other');
  });

  it('offers the domain and the first path segments as rules; GitHub suggests owner/repo', () => {
    expect(ruleChoices('https://docs.google.com/document/d/abc/edit')).toEqual({
      choices: [
        { host: 'docs.google.com', pathPrefix: '', label: 'docs.google.com' },
        { host: 'docs.google.com', pathPrefix: '/document', label: 'docs.google.com/document' },
        { host: 'docs.google.com', pathPrefix: '/document/d', label: 'docs.google.com/document/d' },
      ],
      suggested: 0,
    });
    expect(ruleChoices('https://github.com/me/repo/issues/4').suggested).toBe(2);
    expect(ruleChoices('https://figma.com').choices).toHaveLength(1);
  });
});

describe('links: the Inbox and "always file these here"', () => {
  it('Done when: filing an Inbox item and saving its rule files the next one', async () => {
    const { call } = setup();
    // Nothing matches yet: Inbox.
    const first = await call('POST', '/api/links', { url: 'https://www.figma.com/file/aaa/Landing', title: 'Landing page' });
    expect(first.body.link).toMatchObject({ projectSlug: null, title: 'Landing page', suggested: 0 });
    // A second one arrives before there's a rule.
    const waiting = await call('POST', '/api/links', { url: 'https://figma.com/file/bbb/Logo' });
    expect((await call('GET', '/api/inbox')).body.links).toHaveLength(2);

    // File the first by hand, then "always file these here" with its suggested rule.
    const filed = await call('PUT', `/api/links/${first.body.link.id}`, { slug: 'kratos' });
    expect(filed.body.link).toMatchObject({ projectSlug: 'kratos', filedBy: 'manual' });
    const choice = filed.body.link.choices[filed.body.link.suggested];
    const rule = await call('POST', '/api/link-rules', { slug: 'kratos', host: choice.host, pathPrefix: choice.pathPrefix });
    expect(rule.body).toMatchObject({ rule: { host: 'figma.com', pathPrefix: '', projectSlug: 'kratos' }, filed: 1 });

    // The one already waiting was filed by the rule, and so is the next one.
    expect((await call('GET', '/api/inbox')).body.links).toEqual([]);
    const next = await call('POST', '/api/links', { url: 'https://figma.com/proto/ccc' });
    expect(next.body.link).toMatchObject({ projectSlug: 'kratos', filedBy: 'rule', ruleId: rule.body.rule.id });
    const kratos = (await call('GET', '/api/projects/kratos/links')).body;
    expect(kratos.map((l: { id: number }) => l.id).sort()).toEqual([first.body.link.id, waiting.body.link.id, next.body.link.id].sort());
    expect((await call('GET', '/api/link-rules')).body).toHaveLength(1);
  });

  it('pasting the same page again updates it instead of adding a copy; a slug files it by hand', async () => {
    const { call } = setup();
    const a = await call('POST', '/api/links', { url: 'https://example.com/doc#top' });
    const b = await call('POST', '/api/links', { url: 'https://www.example.com/doc', title: 'The doc', slug: 'radar' });
    expect(b.body).toMatchObject({ existed: true, link: { id: a.body.link.id, title: 'The doc', projectSlug: 'radar', filedBy: 'manual' } });
    expect((await call('POST', '/api/links', { url: 'ftp://example.com/x' })).status).toBe(400);
    expect((await call('POST', '/api/links', { url: 'https://example.com/y', slug: 'nope' })).status).toBe(404);
  });

  it("a GitHub link to a project's repo files itself; filed links stay put when rules change", async () => {
    const { call } = setup();
    expect((await call('POST', '/api/links', { url: 'https://github.com/someone/meme-radar/issues/1' })).body.link).toMatchObject({ projectSlug: 'radar', filedBy: 'github' });
    const manual = (await call('POST', '/api/links', { url: 'https://notion.so/page', slug: 'radar' })).body.link;
    await call('POST', '/api/link-rules', { slug: 'kratos', host: 'notion.so', pathPrefix: '' });
    expect((await call('GET', '/api/projects/radar/links')).body.map((l: { id: number }) => l.id)).toContain(manual.id);
    // Back to the Inbox, then delete.
    expect((await call('PUT', `/api/links/${manual.id}`, { slug: null })).body.link).toMatchObject({ projectSlug: null, filedBy: null });
    expect((await call('DELETE', `/api/links/${manual.id}`)).status).toBe(200);
    expect((await call('DELETE', `/api/links/${manual.id}`)).status).toBe(404);
  });

  it('a rule for the same domain and path replaces the old one; bad rules are refused', async () => {
    const { call } = setup();
    const r1 = (await call('POST', '/api/link-rules', { slug: 'kratos', host: 'WWW.Example.com', pathPrefix: '/Docs/' })).body.rule;
    expect(r1).toMatchObject({ host: 'example.com', pathPrefix: '/docs' });
    const r2 = (await call('POST', '/api/link-rules', { slug: 'radar', host: 'example.com', pathPrefix: '/docs' })).body.rule;
    expect(r2).toMatchObject({ id: r1.id, projectSlug: 'radar' });
    expect((await call('POST', '/api/link-rules', { slug: 'radar', host: 'not a host', pathPrefix: '' })).status).toBe(400);
    expect((await call('POST', '/api/link-rules', { slug: 'nope', host: 'example.com' })).status).toBe(404);
    expect((await call('DELETE', `/api/link-rules/${r1.id}`)).status).toBe(200);
    expect((await call('GET', '/api/link-rules')).body).toEqual([]);
  });

  it("deleting a project puts its links back in the Inbox and drops its rules", async () => {
    const { call } = setup();
    await call('POST', '/api/link-rules', { slug: 'kratos', host: 'figma.com' });
    const l = (await call('POST', '/api/links', { url: 'https://figma.com/file/x' })).body.link;
    expect(l.projectSlug).toBe('kratos');
    expect((await call('DELETE', '/api/projects/kratos')).status).toBe(200);
    expect((await call('GET', '/api/inbox')).body.links.map((x: { id: number }) => x.id)).toEqual([l.id]);
    expect((await call('GET', '/api/link-rules')).body).toEqual([]);
  });

  it("a GitHub repo added to projects.yaml later files the Inbox links it matches", async () => {
    const { call, db, t, dir } = setup();
    await call('POST', '/api/links', { url: 'https://github.com/me/kratos-site/pull/2' });
    fs.writeFileSync(t.projectsFile, yaml(dir).replace(`folders: [${dir}/kratos]`, `folders: [${dir}/kratos]\n    github: [me/kratos-site]`));
    t.store.reload();
    expect(fileInbox(db, listAllProjects(db))).toBe(1);
    expect((await call('GET', '/api/projects/kratos/links')).body[0]).toMatchObject({ filedBy: 'github' });
  });

  it('every links call needs the hub page and its token', async () => {
    const { app } = setup();
    for (const [method, url] of [['GET', '/api/inbox'], ['POST', '/api/links'], ['POST', '/api/link-rules'], ['GET', '/api/projects/kratos/files']]) {
      const res = await app.request(`${HUB}${url}`, { method, headers: { 'Content-Type': 'application/json', Origin: HUB }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status).toBe(403);
    }
  });
});

describe('sessions in the Inbox', () => {
  const unfiled = (db: ReturnType<typeof openDb>, cwd: string, id = '11111111-2222-4333-8444-555555555555') =>
    db.insert(sessions).values({ id, cwd, state: 'ended', lastActiveAt: new Date(), resumable: true }).run();

  it('lists unfiled sessions; filing pins one in projects.yaml without touching the rest', async () => {
    const { db, t, call, dir } = setup();
    fs.mkdirSync(path.join(dir, 'loose'));
    unfiled(db, path.join(dir, 'loose'));
    const inbox = (await call('GET', '/api/inbox')).body;
    expect(inbox.sessions).toMatchObject([{ id: '11111111-2222-4333-8444-555555555555', folder: path.join(dir, 'loose'), folderProblem: null, resumeProblem: null }]);
    const before = fs.readFileSync(t.projectsFile, 'utf8');
    expect((await call('POST', '/api/inbox/sessions/11111111-2222-4333-8444-555555555555/file', { slug: 'kratos' })).status).toBe(200);
    const after = fs.readFileSync(t.projectsFile, 'utf8');
    expect(after).toBe(before.replace(`folders: [${dir}/kratos]`, `folders: [${dir}/kratos]\n    sessions: [11111111-2222-4333-8444-555555555555]`));
    expect((await call('GET', '/api/inbox')).body.sessions).toEqual([]);
  });

  it('"always" adds the folder, so later sessions there file themselves; broad folders are refused', async () => {
    const { db, call, callAs, dir } = setup();
    const loose = path.join(dir, 'loose');
    fs.mkdirSync(path.join(loose, '.claude/worktrees/x'), { recursive: true });
    unfiled(db, path.join(loose, '.claude/worktrees/x'));
    unfiled(db, loose, '99999999-2222-4333-8444-555555555555');
    expect((await call('POST', '/api/inbox/sessions/11111111-2222-4333-8444-555555555555/file', { slug: 'radar', always: true })).status).toBe(200);
    expect(listAllProjects(db).find((p) => p.slug === 'radar')!.folders).toEqual([loose]);
    expect((await call('GET', '/api/inbox')).body.sessions).toEqual([]);

    // Folders outside the home folder are refused, as in the Add form.
    const outside = await callAs(os.homedir(), 'POST', '/api/inbox/sessions/99999999-2222-4333-8444-555555555555/file', { slug: 'kratos', always: true });
    expect(outside).toMatchObject({ status: 400, body: { error: expect.stringMatching(/inside your home folder/) } });

    const home = os.homedir();
    expect(tooBroad(home)).toMatch(/whole home folder/);
    expect(tooBroad(path.join(home, 'Documents'))).toMatch(/too broad/);
    expect(tooBroad(path.dirname(home))).toMatch(/whole home folder/);
    expect(tooBroad(path.join(home, 'Documents/trading-bot'))).toBeNull();
    fs.mkdirSync(path.join(dir, 'Documents'));
    unfiled(db, path.join(dir, 'Documents'), '77777777-2222-4333-8444-555555555555');
    const refused = await call('POST', '/api/inbox/sessions/77777777-2222-4333-8444-555555555555/file', { slug: 'radar', always: true });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringMatching(/too broad.*File just this session/) } });
  });

  it('pinSession and addFolder add to an existing list or start one, and skip what is already there', () => {
    const text = 'projects:\n  - slug: a\n    name: A # keep me\n    sessions: [x]\n';
    expect(pinSession(text, 'a', 'y')).toBe('projects:\n  - slug: a\n    name: A # keep me\n    sessions: [x, y]\n');
    expect(pinSession(text, 'a', 'x')).toBe(text);
    const withFolder = addFolder(text, 'a', path.join(os.homedir(), 'Some Folder'));
    expect(withFolder).toBe('projects:\n  - slug: a\n    name: A # keep me\n    sessions: [x]\n    folders: [~/Some Folder]\n');
    expect(parseProjects(withFolder)[0].folders).toEqual([path.join(os.homedir(), 'Some Folder')]);
  });
});

describe('recent files', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  function repo() {
    const dir = tmp();
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n*.log\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'data/profile'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/old.ts'), 'old');
    fs.utimesSync(path.join(dir, 'src/old.ts'), new Date('2026-01-01'), new Date('2026-01-01'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
    fs.writeFileSync(path.join(dir, 'data/radar.db'), 'x');
    fs.writeFileSync(path.join(dir, 'data/profile/Cookies'), 'x');
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'x');
    fs.writeFileSync(path.join(dir, 'run.log'), 'x');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    return dir;
  }

  function watcher(roots: { dir: string; repo: boolean }[]) {
    const changes: number[] = [];
    const w = fileWatcher({ roots: () => roots, onChange: () => changes.push(Date.now()), debounceMs: 50, log: () => {} });
    cleanups.push(() => w.close());
    w.sync();
    const names = () => w.recent(() => true).map((f) => f.rel);
    return { w, changes, names, ready: () => until(() => w.status().every((s) => s.ready) && w.status().length === roots.length) };
  }

  it('skips .git, node_modules, OS litter and whatever git ignores, newest first', async () => {
    const dir = repo();
    const { names, ready } = watcher([{ dir, repo: true }]);
    await ready();
    await until(() => names().length === 3);
    expect(names()).toEqual(expect.arrayContaining(['README.md', '.gitignore', 'src/old.ts']));
    expect(names().at(-1)).toBe('src/old.ts');
  });

  it('Done when: a saved file shows within 5 seconds; deleting it removes it; new ignored files never show', async () => {
    const dir = repo();
    const { names, ready, changes } = watcher([{ dir, repo: true }]);
    await ready();
    await until(() => names().length === 3);
    const seen = changes.length;
    const saved = Date.now();
    fs.writeFileSync(path.join(dir, 'src/new.ts'), 'new');
    fs.writeFileSync(path.join(dir, 'data/profile/Cache'), 'churn');
    fs.writeFileSync(path.join(dir, 'other.log'), 'churn');
    await until(() => names()[0] === 'src/new.ts');
    expect(Date.now() - saved).toBeLessThan(5000);
    await until(() => changes.length > seen);
    await new Promise((r) => setTimeout(r, 300));
    expect(names()).not.toContain('data/profile/Cache');
    expect(names()).not.toContain('other.log');
    fs.rmSync(path.join(dir, 'src/new.ts'));
    await until(() => !names().includes('src/new.ts'));
  });

  it('a folder that is not a repo uses the built-in list only; a changed .gitignore applies at once', async () => {
    const plain = tmp();
    fs.mkdirSync(path.join(plain, '.obsidian'));
    fs.writeFileSync(path.join(plain, '.obsidian/workspace.json'), '{}');
    fs.writeFileSync(path.join(plain, 'Note.md'), 'x');
    fs.writeFileSync(path.join(plain, 'Note.md.swp'), 'x');
    const dir = repo();
    const { names, ready } = watcher([{ dir: plain, repo: false }, { dir, repo: true }]);
    await ready();
    await until(() => names().includes('Note.md') && names().includes('README.md'));
    expect(names()).not.toContain('.obsidian/workspace.json');
    expect(names()).not.toContain('Note.md.swp');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n*.log\nREADME.md\n');
    await until(() => !names().includes('README.md'));
  });

  it('ignoredByName looks at every folder on the way down, and at the file name', () => {
    expect(ignoredByName('/r', '/r/a/node_modules/x/y.js')).toBe(true);
    expect(ignoredByName('/r', '/r/src/.DS_Store')).toBe(true);
    expect(ignoredByName('/r', '/r/data/radar.db-wal')).toBe(true);
    expect(ignoredByName('/r', '/r/src/build.ts')).toBe(false);
    expect(ignoredByName('/r', '/r')).toBe(false);
  });

  it("the project page gets its own files only, and can open only those, in the editor", async () => {
    const { t, call, dir } = setup();
    fs.writeFileSync(path.join(dir, 'kratos/Plan.md'), 'x');
    fs.writeFileSync(path.join(dir, 'radar/main.py'), 'x');
    t.setFileRoots([{ dir: path.join(dir, 'kratos'), repo: false }, { dir: path.join(dir, 'radar'), repo: false }]);
    t.files.sync();
    await until(() => t.files.status().length === 2 && t.files.status().every((s) => s.ready));
    await until(() => t.files.recent(() => true).length === 2);
    const listed = (await call('GET', '/api/projects/kratos/files')).body;
    expect(listed.files.map((f: { rel: string }) => f.rel)).toEqual(['Plan.md']);
    expect(listed.watching).toMatchObject([{ dir: path.join(dir, 'kratos'), ready: true, error: null }]);

    const open = await call('POST', '/api/launch', { kind: 'file', slug: 'kratos', path: path.join(dir, 'kratos/Plan.md'), dryRun: true });
    expect(open.body.command).toBe(`open -a 'Visual Studio Code' ${path.join(dir, 'kratos/Plan.md')}`);
    // Another project's file, or any other path, is refused.
    for (const p of [path.join(dir, 'radar/main.py'), '/etc/passwd', path.join(dir, 'kratos/../hub.db')]) {
      expect((await call('POST', '/api/launch', { kind: 'file', slug: 'kratos', path: p })).status).toBe(400);
    }
    expect(t.launched).toEqual([]);
  });
});

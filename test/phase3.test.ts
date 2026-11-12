import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { listAllProjects, openDb } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import { browse, checkPaths } from '../src/server/folders.ts';
import { watchFile } from '../src/server/project-store.ts';
import {
  addProject,
  collapseHome,
  removeProject,
  setArchived,
  slugFor,
  updateProject,
  type ProjectInput,
} from '../src/server/projects-file.ts';
import { parseProjects } from '../src/server/projects.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const HOME = os.homedir();

// The shape of the real file: a header comment, a comment inside an entry and
// a quoted path with spaces.
const FILE = `# ~/.project-hub/projects.yaml
# Add github: [owner/repo] and claude_project: <link> when you have them.
projects:
  - slug: kratos-marketing
    name: Kratos Marketing
    folders: ["~/Documents/Obsidian/Main vault /Main/Projects/Kratos"]
    keywords: [kratos]

  - slug: meme-radar
    name: Meme Radar
    repos: [~/meme-radar]
    # ~/Documents/meme-radar no longer exists; kept so its old session stays filed here.
    folders: [~/Documents/meme-radar]

  - slug: crypto-analysis
    name: Crypto Analysis
    folders: [~/Documents/trading-bot]
    sessions: [00000000-0000-4000-8000-000000000001]
`;

const input = (over: Partial<ProjectInput> = {}): ProjectInput => ({
  name: 'New Thing',
  repos: [],
  folders: [],
  github: [],
  claude_project: null,
  keywords: [],
  ...over,
});

describe('projects.yaml edits', () => {
  it('adds a project at the end, in the same style, leaving the rest byte for byte', () => {
    const out = addProject(
      FILE,
      'new-thing',
      input({ repos: [`${HOME}/new-thing`], folders: [`${HOME}/Documents/My Notes`], github: ['me/new-thing'], keywords: ['new', 'thing'] }),
    );
    expect(out.startsWith(FILE)).toBe(true);
    expect(out.slice(FILE.length)).toBe(`
  - slug: new-thing
    name: New Thing
    repos: [~/new-thing]
    folders: [~/Documents/My Notes]
    github: [me/new-thing]
    keywords: [new, thing]
`);
    expect(parseProjects(out).map((p) => p.slug)).toEqual(['kratos-marketing', 'meme-radar', 'crypto-analysis', 'new-thing']);
  });

  it('edits one project and keeps its comment, its pinned sessions and every other entry', () => {
    const out = updateProject(
      FILE,
      'meme-radar',
      input({ name: 'Meme Radar 2', repos: [`${HOME}/meme-radar`], folders: [`${HOME}/Documents/meme-radar`], claude_project: 'https://claude.ai/project/0f6c1c1e-0000-4000-8000-000000000000' }),
    );
    expect(out).toContain('    name: Meme Radar 2\n');
    expect(out).toContain('    # ~/Documents/meme-radar no longer exists');
    expect(out).toContain('    claude_project: https://claude.ai/project/0f6c1c1e-0000-4000-8000-000000000000\n');
    expect(out.split('  - slug: meme-radar')[0]).toBe(FILE.split('  - slug: meme-radar')[0]);
    expect(out.split('  - slug: crypto-analysis')[1]).toBe(FILE.split('  - slug: crypto-analysis')[1]);

    // Emptying a list removes the key rather than writing [].
    const crypto = updateProject(FILE, 'crypto-analysis', input({ name: 'Crypto Analysis' }));
    const [, entry] = crypto.split('  - slug: crypto-analysis\n');
    expect(entry).toBe('    name: Crypto Analysis\n    sessions: [00000000-0000-4000-8000-000000000001]\n');
  });

  it('archives and unarchives with an archived: true line', () => {
    const archived = setArchived(FILE, 'meme-radar', true);
    expect(parseProjects(archived).find((p) => p.slug === 'meme-radar')?.archived).toBe(true);
    expect(archived).toContain('    archived: true\n');
    expect(setArchived(archived, 'meme-radar', false)).toBe(FILE);
  });

  it('writes a hand-removed project back when it is unarchived', () => {
    const removed = removeProject(FILE, 'meme-radar');
    const [fallback] = parseProjects(FILE).filter((p) => p.slug === 'meme-radar');
    const back = setArchived(removed, 'meme-radar', false, fallback);
    expect(parseProjects(back).find((p) => p.slug === 'meme-radar')).toEqual(fallback);
  });

  it('removes only the named entry', () => {
    const out = removeProject(FILE, 'meme-radar');
    expect(parseProjects(out).map((p) => p.slug)).toEqual(['kratos-marketing', 'crypto-analysis']);
    expect(out).not.toContain('meme-radar');
    expect(out.startsWith(FILE.split('  - slug: meme-radar')[0])).toBe(true);
    expect(removeProject(FILE, 'not-there')).toBe(FILE);
  });

  it('refuses to edit a broken file, and refuses duplicate slugs', () => {
    expect(() => addProject('projects:\n  - slug: Bad Slug\n    name: X\n', 'x', input())).toThrow(/kebab-case/);
    expect(() => addProject(FILE, 'meme-radar', input())).toThrow(/already exists/);
    expect(() => updateProject(FILE, 'nope', input())).toThrow(/not in projects.yaml/);
  });

  it('starts an empty file', () => {
    expect(parseProjects(addProject('', 'a', input({ name: 'A' })))).toMatchObject([{ slug: 'a', name: 'A' }]);
  });

  it('makes slugs from names', () => {
    expect(slugFor('Kratos Marketing', [])).toBe('kratos-marketing');
    expect(slugFor('AI Character!', [])).toBe('ai-character');
    expect(slugFor('Data Tools', ['data-tools', 'data-tools-2'])).toBe('data-tools-3');
    expect(slugFor('***', [])).toBe('project');
    expect(collapseHome(`${HOME}/x y`)).toBe('~/x y');
    expect(collapseHome('/opt/x')).toBe('/opt/x');
  });
});

describe('folder picking', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const fakeHome = () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-')));
    dirs.push(home);
    fs.mkdirSync(path.join(home, 'repo/.git'), { recursive: true });
    fs.mkdirSync(path.join(home, 'notes'));
    fs.mkdirSync(path.join(home, '.hidden'));
    fs.mkdirSync(path.join(home, 'Library'));
    fs.writeFileSync(path.join(home, 'file.txt'), '');
    return home;
  };

  it('lists one level of folders, marks repos, hides dotfolders and Library', () => {
    const home = fakeHome();
    const b = browse(undefined, home);
    expect(b).toMatchObject({ path: home, parent: null });
    expect(b.entries.map((e) => [e.name, e.isRepo])).toEqual([
      ['notes', false],
      ['repo', true],
    ]);
    expect(browse(path.join(home, 'notes'), home).parent).toBe(home);
  });

  it('never leaves the home folder, even through a symlink', () => {
    const home = fakeHome();
    expect(() => browse('/etc', home)).toThrow(/inside your home folder/);
    expect(() => browse(path.join(home, '..'), home)).toThrow(/inside your home folder/);
    fs.symlinkSync('/etc', path.join(home, 'escape'));
    expect(() => browse(path.join(home, 'escape'), home)).toThrow(/inside your home folder/);
  });

  it('checks paths from the form', () => {
    const home = fakeHome();
    expect(() => checkPaths([path.join(home, 'repo')], 'repos', [], home)).not.toThrow();
    expect(() => checkPaths([path.join(home, 'notes')], 'repos', [], home)).toThrow(/Not a git repo/);
    expect(() => checkPaths([path.join(home, 'notes')], 'folders', [], home)).not.toThrow();
    expect(() => checkPaths([path.join(home, 'gone')], 'folders', [], home)).toThrow(/Not a folder/);
    // A path the project already lists may be gone (like ~/Documents/meme-radar).
    expect(() => checkPaths([path.join(home, 'gone')], 'folders', [path.join(home, 'gone')], home)).not.toThrow();
    expect(() => checkPaths(['/etc'], 'folders', [], home)).toThrow(/inside your home folder/);
    expect(() => checkPaths(['notes'], 'folders', [], home)).toThrow(/absolute/);
    expect(() => checkPaths([`${home}/notes/../repo`], 'folders', [], home)).toThrow(/absolute/);
  });
});

describe('project store and API', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function setup(text = FILE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
    dirs.push(dir);
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    fs.writeFileSync(t.projectsFile, text);
    t.store.reload();
    const app = createApp(t.deps);
    const page = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = page) =>
      app.request(`${HUB}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const file = () => fs.readFileSync(t.projectsFile, 'utf8');
    const slugs = (archived = false) => listAllProjects(db).filter((p) => p.archived === archived).map((p) => p.slug);
    return { db, app, call, file, slugs, store: t.store, projectsFile: t.projectsFile, dir };
  }

  it('adds, edits, archives, unarchives and deletes, each landing in projects.yaml', async () => {
    const { call, file, slugs, dir } = setup();
    const add = await call('POST', '/api/projects', input({ name: 'AI Character', keywords: ['ai character'] }));
    expect(await add.json()).toEqual({ ok: true, result: 'ai-character' });
    expect(file()).toContain('  - slug: ai-character\n    name: AI Character\n    keywords: [ai character]\n');
    expect(slugs()).toContain('ai-character');

    expect((await call('PUT', '/api/projects/ai-character', input({ name: 'AI Character v2' }))).status).toBe(200);
    expect(file()).toContain('    name: AI Character v2\n');

    expect((await call('POST', '/api/projects/ai-character/archive')).status).toBe(200);
    expect(file()).toContain('    archived: true\n');
    expect(slugs(true)).toEqual(['ai-character']);

    expect((await call('POST', '/api/projects/ai-character/unarchive')).status).toBe(200);
    expect(file()).not.toContain('archived');
    expect(slugs(true)).toEqual([]);

    expect((await call('DELETE', '/api/projects/ai-character')).status).toBe(200);
    expect(file()).toBe(FILE);
    expect(slugs()).not.toContain('ai-character');
    // The previous version is kept.
    expect(fs.readFileSync(path.join(dir, 'backups/projects.last.yaml'), 'utf8')).toContain('ai-character');
  });

  it('delete removes only the hub record: sessions stay (unfiled) and files on disk stay', async () => {
    const { db, call, store } = setup();
    const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notes-'));
    dirs.push(notes);
    fs.writeFileSync(path.join(notes, 'keep.md'), 'mine');
    db.insert(sessions)
      .values({ id: '00000000-0000-4000-8000-000000000001', projectSlug: null, cwd: notes, state: 'ended', lastActiveAt: new Date() })
      .run();
    store.reload();
    expect(db.select().from(sessions).get()?.projectSlug).toBe('crypto-analysis'); // pinned

    const res = await call('DELETE', '/api/projects/crypto-analysis');
    expect(await res.json()).toEqual({ ok: true, result: { unfiledSessions: 1 } });
    expect(db.select().from(sessions).get()).toMatchObject({ projectSlug: null, cwd: notes });
    expect(fs.readFileSync(path.join(notes, 'keep.md'), 'utf8')).toBe('mine');
  });

  it('archived projects keep filing their sessions', async () => {
    const { db, call, store } = setup();
    db.insert(sessions)
      .values({ id: 's1', projectSlug: null, cwd: path.join(HOME, 'meme-radar/src'), state: 'ended', lastActiveAt: new Date() })
      .run();
    await call('POST', '/api/projects/meme-radar/archive');
    store.reload();
    expect(db.select().from(sessions).get()?.projectSlug).toBe('meme-radar');
  });

  it('refuses writes that do not come from the hub page', async () => {
    const { call, file } = setup();
    const body = input({ name: 'Sneaky' });
    const noToken = { Origin: HUB, 'Content-Type': 'application/json' };
    const otherSite = { Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    expect((await call('POST', '/api/projects', body, noToken)).status).toBe(403);
    expect((await call('POST', '/api/projects', body, otherSite)).status).toBe(403);
    expect((await call('PUT', '/api/projects/meme-radar', body, noToken)).status).toBe(403);
    expect((await call('POST', '/api/projects/meme-radar/archive', undefined, { Origin: HUB })).status).toBe(403);
    expect((await call('DELETE', '/api/projects/meme-radar', undefined, { 'X-Hub-Token': 'ui-t0ken' })).status).toBe(403);
    expect((await call('GET', '/api/folders/browse', undefined, {})).status).toBe(403);
    expect((await call('GET', '/api/folders/browse', undefined, { 'X-Hub-Token': 'ui-t0ken', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(file()).toBe(FILE);
  });

  it('rejects bad input with a reason and leaves the file alone', async () => {
    const { call, file } = setup();
    const bad = async (body: unknown, url = '/api/projects', method = 'POST') => {
      const res = await call(method, url, body);
      expect(res.status).toBe(400);
      return (await res.json()).error as string;
    };
    expect(await bad(input({ name: ' ' }))).toMatch(/Name is required/);
    expect(await bad(input({ github: ['not a repo'] }))).toMatch(/owner\/repo/);
    expect(await bad(input({ claude_project: 'https://example.com/x' }))).toMatch(/claude\.ai\/project/);
    expect(await bad(input({ folders: ['/etc'] }))).toMatch(/inside your home folder/);
    expect(await bad(input({ repos: [path.join(HOME, 'definitely-not-here-xyz')] }))).toMatch(/Not a folder/);
    expect(await bad(input(), '/api/projects/nope', 'PUT')).toMatch(/Unknown project/);
    expect(file()).toBe(FILE);
  });

  it('a broken hand edit keeps the last good projects and reports the error', async () => {
    const { app, store, projectsFile, slugs } = setup();
    fs.writeFileSync(projectsFile, 'projects:\n  - slug: Bad Slug\n');
    store.reload();
    expect(store.error()).toMatch(/kebab-case/);
    expect(slugs()).toEqual(['crypto-analysis', 'kratos-marketing', 'meme-radar']);
    expect(await (await app.request(`${HUB}/api/projects-file`, { headers: PAGE_GET })).json()).toEqual({ error: expect.stringMatching(/kebab-case/) });
  });

  it('picks up a hand edit to projects.yaml without a restart', async () => {
    const { store, projectsFile, slugs } = setup();
    const watcher = watchFile(projectsFile, store.reload);
    try {
      // Replace the file the way editors do: write elsewhere, then rename over it.
      const tmp = `${projectsFile}.tmp`;
      fs.writeFileSync(tmp, `${FILE}\n  - slug: by-hand\n    name: By Hand\n`);
      fs.renameSync(tmp, projectsFile);
      await expect.poll(() => slugs(), { timeout: 5000 }).toContain('by-hand');
    } finally {
      watcher.close();
    }
  });
});

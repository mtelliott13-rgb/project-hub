// The per-project Toolkit checklist (toolkit.yaml in a project folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { watchFile } from '../src/server/project-store.ts';
import { findToolkitFiles, parseToolkit, setToolkitStatus, versionOf, writeToolkitStatus } from '../src/server/toolkit.ts';
import { groupToolkit, isOverdue } from '../web/src/toolkit-view.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

// Hand-written, with everything the hub must leave alone: comments (own-line
// and trailing), quoting, extra fields, a missing status, odd links.
const FILE = `# Career toolkit. Owned by the Career HQ session.
items:
  # Finance first
  - name: Bloomberg Market Concepts
    category: Finance
    url: https://portal.bloombergforeducation.com/
    cost: $149
    why: Fluency with the terminal most finance teams use
    target: 2026-11-15
    status: in progress   # started Oct 20
    notes: keep my login in 1Password

  - name: "CFA Level I"
    category: Finance
    url: "https://www.cfainstitute.org/programs/cfa-program"
    cost: "$1,250 + $350 enrollment"
    why: The credential most asset managers ask for
    status: 'not started'

  - name: Excel shortcuts course
    category: Software
    url: javascript:alert(1)
    cost: free
    why: Faster models

  - name: SQL for analysts
    category: Software
    url: www.example.com/sql
    cost: 0
    why: Pull my own data
    status: done

  - name: Python course
    category: Software
    why: Automate reports
    status: parked
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-')));
  dirs.push(d);
  return d;
};

describe('reading toolkit.yaml', () => {
  const t = parseToolkit(FILE, '/u/career-hq/toolkit.yaml');

  it('counts done out of everything except parked', () => {
    expect(t.items).toHaveLength(5);
    expect([t.done, t.total]).toEqual([1, 4]);
  });

  it('reads each field, defaulting a missing status to not started', () => {
    expect(t.items[0]).toEqual({
      index: 0,
      name: 'Bloomberg Market Concepts',
      category: 'Finance',
      url: 'https://portal.bloombergforeducation.com/',
      urlText: 'https://portal.bloombergforeducation.com/',
      cost: '$149',
      why: 'Fluency with the terminal most finance teams use',
      target: '2026-11-15',
      status: 'in progress',
      unknownStatus: null,
    });
    expect(t.items[1]).toMatchObject({ name: 'CFA Level I', cost: '$1,250 + $350 enrollment', status: 'not started' });
    expect(t.items[2].status).toBe('not started');
    expect(t.items[3].cost).toBe('0');
  });

  it('links only http and https', () => {
    expect(t.items[2]).toMatchObject({ url: null, urlText: 'javascript:alert(1)' });
    expect(t.items[3]).toMatchObject({ url: null, urlText: 'www.example.com/sql' });
    expect(t.items[4]).toMatchObject({ url: null, urlText: null });
  });

  it('shows an unknown status as is, counting it as not done', () => {
    const odd = parseToolkit('items:\n  - name: A\n    status: Done-ish\n  - name: B\n    status: DONE\n', 'f');
    expect(odd.items[0]).toMatchObject({ status: 'not started', unknownStatus: 'Done-ish' });
    expect(odd.items[1]).toMatchObject({ status: 'done', unknownStatus: null }); // case doesn't matter
    expect([odd.done, odd.total]).toEqual([1, 2]);
  });

  it('reports a broken file or items without a name instead of guessing', () => {
    expect(() => parseToolkit('items: [unclosed\n', 'f')).toThrow(/not valid YAML/);
    expect(() => parseToolkit('stuff: 1\n', 'f')).toThrow(/top-level `items:`/);
    const partial = parseToolkit('items:\n  - name: A\n  - cost: 5\n  - just a string\n', 'f');
    expect(partial.items.map((i) => i.name)).toEqual(['A']);
    expect(partial.problems).toEqual(["Item 2 has no name, so it's skipped", "Item 3 has no name, so it's skipped"]);
  });

  it('finds toolkit.yaml at the top level of a repo or folder only', () => {
    const repo = tmp();
    const folder = tmp();
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'toolkit.yaml'), FILE); // not top level
    expect(findToolkitFiles({ repos: [repo], folders: [folder] })).toEqual([]);
    fs.writeFileSync(path.join(folder, 'toolkit.yaml'), FILE);
    fs.writeFileSync(path.join(repo, 'toolkit.yaml'), FILE);
    expect(findToolkitFiles({ repos: [repo], folders: [folder] })).toEqual([path.join(repo, 'toolkit.yaml'), path.join(folder, 'toolkit.yaml')]);
  });
});

describe('writing one status', () => {
  /** Lines that differ between two texts of the same length in lines. */
  const changed = (a: string, b: string) => {
    const [x, y] = [a.split('\n'), b.split('\n')];
    return y.map((line, i) => (line !== x[i] ? [x[i], line] : null)).filter(Boolean);
  };

  it('changes only that value: the comment on the same line, quoting and other fields stay', () => {
    const out = setToolkitStatus(FILE, 0, 'Bloomberg Market Concepts', 'done');
    expect(changed(FILE, out)).toEqual([['    status: in progress   # started Oct 20', '    status: done   # started Oct 20']]);
  });

  it('keeps the quote style the file used', () => {
    expect(changed(FILE, setToolkitStatus(FILE, 1, 'CFA Level I', 'in progress'))).toEqual([["    status: 'not started'", "    status: 'in progress'"]]);
    const dq = 'items:\n  - name: A\n    status: "done"\n';
    expect(setToolkitStatus(dq, 0, 'A', 'parked')).toBe('items:\n  - name: A\n    status: "parked"\n');
  });

  it("adds a status line, at the item's indent, when it had none", () => {
    const out = setToolkitStatus(FILE, 2, 'Excel shortcuts course', 'in progress');
    expect(out).toBe(FILE.replace('    why: Faster models\n', '    why: Faster models\n    status: in progress\n'));
    const last = 'items:\n- name: A\n  cost: 1   # no status yet\n';
    expect(setToolkitStatus(last, 0, 'A', 'done')).toBe('items:\n- name: A\n  cost: 1   # no status yet\n  status: done\n');
  });

  it('refuses when the item at that position is no longer the one the page showed', () => {
    expect(() => setToolkitStatus(FILE, 1, 'Bloomberg Market Concepts', 'done')).toThrow(/no longer "Bloomberg Market Concepts"/);
    expect(() => setToolkitStatus(FILE, 9, 'X', 'done')).toThrow(/no longer/);
  });

  it('refuses shapes it would have to rewrite, rather than reformat them', () => {
    expect(() => setToolkitStatus('items:\n  - {name: A, cost: 1}\n', 0, 'A', 'done')).toThrow(/add its status line by hand/);
    expect(() => setToolkitStatus('items:\n  - name: A\n    status: [x]\n', 0, 'A', 'done')).toThrow(/isn't a plain value/);
  });

  it('writes only if the file is the version the page loaded, backing it up before the first write', () => {
    const dir = tmp();
    const file = path.join(dir, 'toolkit.yaml');
    fs.writeFileSync(file, FILE, { mode: 0o640 });
    const backupDir = path.join(dir, 'backups');
    const backedUp = new Set<string>();
    const base = { file, backupDir, backedUp };

    const t1 = writeToolkitStatus({ ...base, version: versionOf(FILE), index: 0, name: 'Bloomberg Market Concepts', status: 'done' });
    expect(t1.done).toBe(2);
    expect(fs.readdirSync(backupDir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]), 'utf8')).toBe(FILE); // the original
    expect(fs.statSync(file).mode & 0o777).toBe(0o640); // permissions kept

    // A second write in the same run: no second backup.
    writeToolkitStatus({ ...base, version: t1.version, index: 1, name: 'CFA Level I', status: 'in progress' });
    expect(fs.readdirSync(backupDir)).toHaveLength(1);

    // Someone else edits the file: a write based on the old version is refused and nothing changes.
    const theirs = fs.readFileSync(file, 'utf8').replace('Faster models', 'Faster models, says Career HQ');
    fs.writeFileSync(file, theirs);
    expect(() => writeToolkitStatus({ ...base, version: t1.version, index: 3, name: 'SQL for analysts', status: 'parked' })).toThrow(/changed outside the hub/);
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs);
    expect(fs.existsSync(`${file}.project-hub-tmp`)).toBe(false);
  });
});

describe('the page layout', () => {
  const items = parseToolkit(FILE, 'f').items;

  it('puts in-progress items in their own group first, then categories in file order', () => {
    expect(groupToolkit(items).map((g) => [g.title, g.items.map((i) => i.name)])).toEqual([
      ['In progress', ['Bloomberg Market Concepts']],
      ['Finance', ['CFA Level I']],
      ['Software', ['Excel shortcuts course', 'SQL for analysts', 'Python course']],
    ]);
    expect(groupToolkit([])).toEqual([]);
  });

  it('flags a target date that has passed, unless the item is done or parked', () => {
    const now = new Date(2026, 10, 16); // 16 Nov 2026, local time
    expect(isOverdue({ target: '2026-11-15', status: 'in progress' }, now)).toBe(true);
    expect(isOverdue({ target: '2026-11-16', status: 'in progress' }, now)).toBe(false); // due today
    expect(isOverdue({ target: '2026-11-15', status: 'done' }, now)).toBe(false);
    expect(isOverdue({ target: '2026-11-15', status: 'parked' }, now)).toBe(false);
    expect(isOverdue({ target: 'end of Q4', status: 'not started' }, now)).toBe(false);
  });
});

describe('API', () => {
  function setup() {
    const dir = tmp();
    const repo = path.join(dir, 'career-hq');
    fs.mkdirSync(repo);
    const file = path.join(repo, 'toolkit.yaml');
    fs.writeFileSync(file, FILE);
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    fs.writeFileSync(t.projectsFile, `projects:\n  - slug: career-hq\n    name: Career HQ\n    repos: [${repo}]\n  - slug: other\n    name: Other\n`);
    t.store.reload();
    const app = createApp(t.deps);
    const page = { Origin: HUB, 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    const get = async (url: string) => (await app.request(`${HUB}${url}`, { headers: PAGE_GET })).json();
    const put = async (index: number, body: unknown, headers: Record<string, string> = page) => {
      const res = await app.request(`${HUB}/api/projects/career-hq/toolkit/items/${index}`, { method: 'PUT', headers, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { file, dir, get, put, deps: t.deps };
  }

  it('cards get "done of total" only for projects that have the file', async () => {
    const { get, file } = setup();
    const projects = await get('/api/projects');
    expect(projects.map((p: { slug: string; toolkit: unknown }) => [p.slug, p.toolkit])).toEqual([
      ['career-hq', { file, done: 1, total: 4, error: null }],
      ['other', null],
    ]);
    expect((await get('/api/projects/other/toolkit')).error).toMatch(/No toolkit.yaml/);
  });

  it('a status change writes the file; a stale page gets 409 and the current version, and nothing is written', async () => {
    const { get, put, file } = setup();
    const loaded = await get('/api/projects/career-hq/toolkit');
    const ok = await put(3, { name: 'SQL for analysts', status: 'parked', version: loaded.version });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ done: 0, total: 3 });
    expect(fs.readFileSync(file, 'utf8')).toBe(FILE.replace('    status: done\n', '    status: parked\n'));

    // The page still holds the first version: refused, with what's there now.
    const stale = await put(0, { name: 'Bloomberg Market Concepts', status: 'done', version: loaded.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed outside the hub/);
    expect(stale.body.current.items[3]).toMatchObject({ name: 'SQL for analysts', status: 'parked' });
    expect(fs.readFileSync(file, 'utf8')).toContain('status: in progress   # started Oct 20');
  });

  it('refuses bad input and anything not from the hub page', async () => {
    const { get, put, file } = setup();
    const { version } = await get('/api/projects/career-hq/toolkit');
    expect((await put(0, { name: 'Bloomberg Market Concepts', status: 'finished', version })).status).toBe(400);
    expect((await put(0, { name: 'Bloomberg Market Concepts', status: 'done' })).status).toBe(400);
    expect((await put(0, { name: 'Bloomberg Market Concepts', status: 'done', version }, { 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' })).status).toBe(403);
    expect((await put(0, { name: 'Bloomberg Market Concepts', status: 'done', version }, { Origin: HUB, 'Content-Type': 'application/json' })).status).toBe(403);
    // Extra fields can't point it at another file.
    expect((await put(0, { name: 'Bloomberg Market Concepts', status: 'done', version, file: '/etc/hosts' })).status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toContain('    status: done   # started Oct 20');
  });

  it('a broken file shows as an error on the card and page, not as a crash', async () => {
    const { get, file } = setup();
    fs.writeFileSync(file, 'items: [unclosed\n');
    const [p] = await get('/api/projects');
    expect(p.toolkit).toMatchObject({ error: expect.stringMatching(/not valid YAML/) });
    expect((await get('/api/projects/career-hq/toolkit')).error).toMatch(/not valid YAML/);
  });

  it('an edit outside the hub is noticed without a restart, including a file that appears later', async () => {
    const { dir } = setup();
    const later = path.join(dir, 'later', 'toolkit.yaml');
    fs.mkdirSync(path.dirname(later));
    let changes = 0;
    const watcher = watchFile(later, () => changes++);
    try {
      fs.writeFileSync(later, FILE); // created
      await expect.poll(() => changes, { timeout: 5000 }).toBeGreaterThan(0);
      const seen = changes;
      fs.writeFileSync(`${later}.tmp`, FILE.replace('done', 'parked'));
      fs.renameSync(`${later}.tmp`, later); // replaced, the way editors save
      await expect.poll(() => changes, { timeout: 5000 }).toBeGreaterThan(seen);
    } finally {
      watcher.close();
    }
  });
});

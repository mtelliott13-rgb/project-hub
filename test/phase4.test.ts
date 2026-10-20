import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { projectDocs } from '../src/server/docs.ts';
import { addIdea, cleanText, editIdea, IDEAS_HEADER, parseIdeas } from '../src/server/ideas.ts';
import { MONETIZE_HEADINGS, monetizeCommand, monetizeJobs, READ_AND_WEB_TOOLS } from '../src/server/monetize.ts';
import { withoutPids } from '../src/server/sessions.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
  dirs.push(d);
  return d;
};

describe('notes and Monetize drafts on disk', () => {
  it('saves notes as plain text', () => {
    const docs = projectDocs(tmp());
    expect(docs.notes('acme')).toEqual({ text: '', savedAt: null });
    docs.saveNotes('acme', 'line 1\nline 2');
    expect(docs.notes('acme').text).toBe('line 1\nline 2');
    expect(fs.readFileSync(path.join(docs.dir('acme'), 'notes.md'), 'utf8')).toBe('line 1\nline 2');
  });

  it('keeps every draft, newest first, and edits one in place', () => {
    const docs = projectDocs(tmp());
    const a = docs.addDraft('acme', '## Who would pay\nA\n', 0.21, new Date('2026-10-20T10:00:00.000Z'));
    const b = docs.addDraft('acme', '## Who would pay\nB\n', null, new Date('2026-10-21T10:00:00.000Z'));
    expect(a).toBe('2026-10-20T10-00-00-000Z');
    expect(docs.drafts('acme').map((d) => d.id)).toEqual([b, a]);
    expect(docs.drafts('acme')[1]).toEqual({ id: a, generatedAt: '2026-10-20T10:00:00.000Z', costUsd: 0.21, editedAt: null });

    docs.editDraft('acme', a, 'my edit: with a colon\n', new Date('2026-10-22T09:00:00.000Z'));
    expect(docs.draft('acme', a)).toEqual({
      id: a,
      generatedAt: '2026-10-20T10:00:00.000Z',
      costUsd: 0.21,
      editedAt: '2026-10-22T09:00:00.000Z',
      text: 'my edit: with a colon\n',
    });
    expect(docs.draft('acme', b)?.text).toBe('## Who would pay\nB\n');
    expect(() => docs.draft('acme', '../../etc/passwd')).toThrow(/Bad draft id/);
  });
});

describe('Generate', () => {
  const project = { name: 'Meme Radar', keywords: ['meme radar'], repos: ['/u/meme-radar'], folders: ['/u/notes', '/u/gone'] };

  it('builds the exact command: read and web tools only, nothing saved, other folders added', () => {
    const cmd = monetizeCommand(project, (d) => d !== '/u/gone', '/hub/projects/meme-radar');
    expect(cmd.cwd).toBe('/u/meme-radar');
    const [bin, p, prompt, ...flags] = cmd.argv;
    expect([bin, p]).toEqual(['claude', '-p']);
    expect(flags).toEqual([
      '--restricted',
      '--tools',
      'Read,Glob,Grep,WebSearch,WebFetch',
      '--allowedTools',
      ...READ_AND_WEB_TOOLS,
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format',
      'json',
      '--add-dir',
      '/u/notes',
    ]);
    expect(flags.join(' ')).not.toMatch(/Bash|Edit|Write|bypass/);
    for (const h of MONETIZE_HEADINGS) expect(prompt).toContain(`## ${h}`);
    expect(prompt).toContain('Do not change any files');
    expect(prompt).toContain('/u/meme-radar, /u/notes');
  });

  it("runs in the hub's own folder for the project when none of its folders exist", () => {
    const cmd = monetizeCommand({ ...project, repos: [], folders: [] }, () => false, '/hub/projects/ai');
    expect(cmd.cwd).toBe('/hub/projects/ai');
    expect(cmd.argv[2]).toContain('no folders yet');
    expect(cmd.argv).not.toContain('--add-dir');
  });

  it('runs one job per project at a time and reports failures', async () => {
    let finish!: () => void;
    const done: string[] = [];
    const jobs = monetizeJobs(
      (slug) =>
        slug === 'bad'
          ? Promise.reject(new Error('Claude returned no draft'))
          : new Promise((r) => (finish = () => r({ text: 'x', costUsd: null }))),
      (slug) => done.push(slug),
      () => {},
    );
    expect(jobs.start('a')).toBe(true);
    expect(jobs.start('a')).toBe(false);
    expect(jobs.get('a')).toMatchObject({ state: 'running' });
    finish();
    await expect.poll(() => jobs.get('a')).toBeNull();
    expect(done).toEqual(['a']);

    jobs.start('bad');
    await expect.poll(() => jobs.get('bad')?.state).toBe('failed');
    expect(jobs.get('bad')).toMatchObject({ error: 'Claude returned no draft' });
    expect(jobs.start('bad')).toBe(true); // A failed one can be retried.
  });
});

describe("Generate's own process", () => {
  it('is left out of the running-sessions poll', () => {
    const agents = [
      { sessionId: 'yours', pid: 100, cwd: '/u/a' },
      { sessionId: 'generate', pid: 200, cwd: '/u/a' },
      { sessionId: 'no-pid', cwd: '/u/a' },
    ];
    expect(withoutPids(agents, new Set([200])).map((a) => a.sessionId)).toEqual(['yours', 'no-pid']);
  });
});

describe('ideas.md', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it('starts a file with instructions Claude Code can follow', () => {
    const text = addIdea('', { text: 'Cmd-K switcher', scope: 'hub' }, now);
    expect(text).toBe(`${IDEAS_HEADER}- [ ] Cmd-K switcher · hub · added 2026-10-20\n`);
    expect(text).toContain('what\'s next');
    expect(parseIdeas(text)).toEqual([
      { line: 7, text: 'Cmd-K switcher', scope: 'hub', done: false, added: '2026-10-20', doneOn: null },
    ]);
  });

  it('adds after the last item, keeping anything written by hand', () => {
    let text = addIdea('', { text: 'One', scope: 'hub' }, now);
    text += '\nSome note typed by hand.\n';
    text = addIdea(text, { text: 'Two', scope: 'meme-radar' }, now);
    expect(parseIdeas(text).map((i) => [i.text, i.scope])).toEqual([
      ['One', 'hub'],
      ['Two', 'meme-radar'],
    ]);
    expect(text).toContain('Some note typed by hand.');
  });

  it('ticks, unticks, edits and deletes one line, refusing if the file moved underneath', () => {
    let text = addIdea(addIdea('', { text: 'One', scope: 'hub' }, now), { text: 'Two', scope: 'hub' }, now);
    const [one, two] = parseIdeas(text);
    text = editIdea(text, two.line, 'Two', { done: true }, new Date('2026-10-21T08:00:00Z'));
    expect(text).toContain('- [x] Two · hub · added 2026-10-20 · done 2026-10-21');
    text = editIdea(text, two.line, 'Two', { done: false }, now);
    expect(text).toContain('- [ ] Two · hub · added 2026-10-20\n');
    text = editIdea(text, one.line, 'One', { text: 'One, renamed', scope: 'data-tools' }, now);
    expect(parseIdeas(text)[0]).toMatchObject({ text: 'One, renamed', scope: 'data-tools' });
    expect(() => editIdea(text, one.line, 'One', 'delete')).toThrow(/changed since/);
    text = editIdea(text, one.line, 'One, renamed', 'delete');
    expect(parseIdeas(text).map((i) => i.text)).toEqual(['Two']);
  });

  it('reads items Claude Code ticked by hand', () => {
    const text = '# Ideas\n\n- [x] Cmd-K switcher · hub · added 2026-10-20 · done 2026-10-22\n- [X] Bare item\n';
    expect(parseIdeas(text)).toMatchObject([
      { text: 'Cmd-K switcher', done: true, doneOn: '2026-10-22' },
      { text: 'Bare item', scope: 'hub', done: true, doneOn: null },
    ]);
  });

  it('keeps idea text to one line without the separator', () => {
    expect(cleanText('  multi\nline   text ')).toBe('multi line text');
    expect(cleanText('a · b')).toBe('a - b');
    expect(() => cleanText('   ')).toThrow(/needs some text/);
  });
});

describe('project page API', () => {
  function setup() {
    const dir = tmp();
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    fs.writeFileSync(t.projectsFile, 'projects:\n  - slug: acme\n    name: Acme\n');
    t.store.reload();
    const app = createApp(t.deps);
    const page = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = method === 'GET' ? PAGE_GET : page) => {
      const res = await app.request(`${HUB}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { call, t, dir };
  }

  it('saves and reads notes', async () => {
    const { call } = setup();
    expect((await call('PUT', '/api/projects/acme/notes', { text: 'hello' })).status).toBe(200);
    expect((await call('GET', '/api/projects/acme/notes')).body).toMatchObject({ text: 'hello' });
    expect((await call('GET', '/api/projects/nope/notes')).status).toBe(404);
  });

  it('Generate runs only when asked, saves a new draft each time, and drafts can be edited', async () => {
    const { call, t } = setup();
    const before = await call('GET', '/api/projects/acme/monetize');
    expect(before.body).toMatchObject({ drafts: [], job: null });
    expect(before.body.command).toMatch(/^cd .* && claude -p '.*--restricted --tools Read,Glob,Grep,WebSearch,WebFetch/s);
    expect(t.generated).toEqual([]); // Nothing runs on its own.

    expect((await call('POST', '/api/projects/acme/monetize/generate', {})).status).toBe(202);
    await expect.poll(async () => (await call('GET', '/api/projects/acme/monetize')).body.drafts.length).toBe(1);
    await new Promise((r) => setTimeout(r, 5)); // Distinct timestamps.
    await call('POST', '/api/projects/acme/monetize/generate', {});
    await expect.poll(async () => (await call('GET', '/api/projects/acme/monetize')).body.drafts.length).toBe(2);
    expect(t.generated).toEqual(['acme', 'acme']);

    const [latest] = (await call('GET', '/api/projects/acme/monetize')).body.drafts;
    expect(latest.costUsd).toBe(0.12);
    expect((await call('PUT', `/api/projects/acme/monetize/${latest.id}`, { text: 'edited' })).status).toBe(200);
    expect((await call('GET', `/api/projects/acme/monetize/${latest.id}`)).body).toMatchObject({ text: 'edited' });
    expect((await call('GET', '/api/projects/acme/monetize/..%2F..%2Fx')).status).toBe(404);
  });

  it('adds, ticks and deletes ideas, checking the scope', async () => {
    const { call, t } = setup();
    const added = await call('POST', '/api/ideas', { text: 'RugCheck alerts', scope: 'acme' });
    expect(added.body.items).toMatchObject([{ text: 'RugCheck alerts', scope: 'acme', done: false }]);
    expect((await call('POST', '/api/ideas', { text: 'x', scope: 'nope' })).status).toBe(400);

    const [idea] = added.body.items;
    const ticked = await call('PUT', `/api/ideas/${idea.line}`, { expect: 'RugCheck alerts', done: true });
    expect(ticked.body.items[0]).toMatchObject({ done: true });
    expect((await call('PUT', `/api/ideas/${idea.line}`, { expect: 'stale text', done: false })).status).toBe(409);
    expect(fs.readFileSync(t.deps.ideasFile, 'utf8')).toMatch(/- \[x\] RugCheck alerts · acme · added \d{4}-\d{2}-\d{2} · done/);

    expect((await call('DELETE', `/api/ideas/${idea.line}`, { expect: 'RugCheck alerts' })).body.items).toEqual([]);
  });

  it('every API read and write needs the page token; only health and events are open', async () => {
    const { call } = setup();
    for (const url of ['/api/projects', '/api/projects-file', '/api/projects/acme/notes', '/api/projects/acme/monetize', '/api/ideas']) {
      expect((await call('GET', url, undefined, {})).status, url).toBe(403);
    }
    const noOrigin = { 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    expect((await call('POST', '/api/projects/acme/monetize/generate', {}, noOrigin)).status).toBe(403);
    expect((await call('PUT', '/api/projects/acme/notes', { text: 'x' }, noOrigin)).status).toBe(403);
    expect((await call('POST', '/api/ideas', { text: 'x' }, noOrigin)).status).toBe(403);
    expect((await call('GET', '/api/health', undefined, {})).status).toBe(200);
  });
});

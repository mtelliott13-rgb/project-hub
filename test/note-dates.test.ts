// Dates in notes (phase 5): which lines get an "Add to calendar?" suggestion,
// found locally, and the dismissals the hub remembers (hashes only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { noteDismissals } from '../src/server/db/schema.ts';
import { datedLines, looksDated } from '../web/src/project/note-dates.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('which lines look dated', () => {
  it.each([
    'Call the bank tomorrow',
    'Demo on Friday',
    'Standup Mon 9:30',
    'Report due Dec 10',
    'due 3rd of March',
    'Renew by 12/3',
    'Dentist 3pm',
    'sync at 14:30',
    'Trip in December',
    'next week: write the summary',
  ])('yes: %s', (line) => expect(looksDated(line)).toBe(true));

  it.each([
    'Refactor the parser',
    'I sat on this for a while',
    'Sun glare in the photos',
    'may need a new key',
    'mar the finish',
    'Version 2.13 released',
    'see https://example.com/2026/12/3/post',
    'run `sleep 10:30` in the log',
    '13/45 tests passing',
  ])('no: %s', (line) => expect(looksDated(line)).toBe(false));

  it('skips done items, code fences, and repeats; strips list markers', () => {
    const notes = ['# Plan', '- [ ] Email Sam on Tuesday', '- [x] Call Pat tomorrow', '```', 'cron 10:30 daily', '```', '1. Lab due Dec 10', '- [ ] Email Sam on Tuesday', ''].join('\n');
    expect(datedLines(notes)).toEqual([
      { line: '- [ ] Email Sam on Tuesday', text: 'Email Sam on Tuesday' },
      { line: '1. Lab due Dec 10', text: 'Lab due Dec 10' },
    ]);
  });
});

describe('dismissals', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-notes-'));
    dirs.push(dir);
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    fs.writeFileSync(t.projectsFile, 'projects:\n  - slug: demo\n    name: Demo\n');
    t.store.reload();
    const app = createApp(t.deps);
    const req = (p: string, init: RequestInit = {}) => app.request(`${HUB}${p}`, init);
    return { db, t, req };
  }
  const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const WRITE = { ...PAGE_GET, Origin: HUB, 'Content-Type': 'application/json' };

  it('stores only a hash per project, once, and lists them back', async () => {
    const { db, req } = setup();
    const h = hash('- [ ] Email Sam on Tuesday');
    for (let i = 0; i < 2; i++) expect((await req('/api/projects/demo/note-dismissals', { method: 'POST', headers: WRITE, body: JSON.stringify({ hash: h }) })).status).toBe(200);
    expect(await (await req('/api/projects/demo/note-dismissals', { headers: PAGE_GET })).json()).toEqual([h]);
    expect(db.select().from(noteDismissals).all().map((r) => Object.keys(r).sort())).toEqual([['createdAt', 'lineHash', 'projectSlug']]);
  });

  it('refuses text instead of a hash, unknown projects and other origins', async () => {
    const { req } = setup();
    expect((await req('/api/projects/demo/note-dismissals', { method: 'POST', headers: WRITE, body: JSON.stringify({ hash: 'Email Sam on Tuesday' }) })).status).toBe(400);
    expect((await req('/api/projects/nope/note-dismissals', { method: 'POST', headers: WRITE, body: JSON.stringify({ hash: hash('x') }) })).status).toBe(404);
    expect((await req('/api/projects/demo/note-dismissals', { method: 'POST', headers: { ...WRITE, Origin: 'https://evil.example.com' }, body: JSON.stringify({ hash: hash('x') }) })).status).toBe(403);
  });

  it('go away with the project', async () => {
    const { db, req, t } = setup();
    await req('/api/projects/demo/note-dismissals', { method: 'POST', headers: WRITE, body: JSON.stringify({ hash: hash('x') }) });
    t.store.remove('demo');
    expect(db.select().from(noteDismissals).all()).toEqual([]);
  });
});

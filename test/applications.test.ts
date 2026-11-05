// Applications: Career HQ's review queue, fill sheets, status writes and PDF launches.
// All data here is made up; no real queue or fill sheet is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packetDir, parseFillSheet, parseQueue, QUEUE_FILE, queueSummary, readQueue, setQueueStatus, sortApplications, writeQueueStatus } from '../src/server/applications.ts';
import { createApp } from '../src/server/app.ts';
import { watchFile } from '../src/server/project-store.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb } from '../src/server/db/index.ts';
import { AGENT_TOKEN, HUB, PAGE_GET, testDeps } from './helpers.ts';

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

const QUEUE = `# Written by career-hq. Project Hub changes only status.
items:
  - id: "2026-11-03-acme-energy-data-analyst-intern"
    company: "Acme Energy"
    title: "Data Analyst Intern"
    status: "draft"
    fit: "possible"
    location: "Denver, CO"
    url: "https://example.com/jobs/123"
    added: "2026-11-03"
    deadline: "2026-12-01"
    packet: "jobs/packets/2026-11-03-acme-energy-data-analyst-intern"
    notes: ""

  - id: "2026-10-28-globex-ops-analyst"
    company: "Globex"
    title: "Operations Analyst"
    status: "submitted"
    fit: "strong"
    added: "2026-10-28"
    submitted_on: "2026-10-30"
    packet: "jobs/packets/2026-10-28-globex-ops-analyst"

  - id: "2026-11-01-initech-intern"
    company: "Initech"
    title: "Analytics Intern"
    status: "reviewed"
    fit: "great"   # not a verdict
    added: "2026-11-01"
    deadline: "2026-11-20"
    url: "ftp://example.com/nope"
    packet: "../outside"
`;

const SHEET = `# Fill sheet — Acme Energy · Data Analyst Intern

Copy top to bottom. \`[not in profile]\` means it was never given.

## 1. Personal info

**First name**
\`\`\`
Pat
\`\`\`

**GitHub**
\`\`\`
[not in profile]
\`\`\`

## 5. Work experience

### Example Co — Intern

**Description** (58 characters)
\`\`\`
- Built a dashboard
- Cleaned survey data for 3 teams
\`\`\`

> Role wording not approved yet.
> Ask before using it.
`;

function repo() {
  const root = tmp();
  const career = path.join(root, 'career');
  fs.mkdirSync(path.join(career, 'jobs/queue'), { recursive: true });
  fs.writeFileSync(path.join(career, QUEUE_FILE), QUEUE);
  const acme = path.join(career, 'jobs/packets/2026-11-03-acme-energy-data-analyst-intern');
  fs.mkdirSync(acme, { recursive: true });
  fs.writeFileSync(path.join(acme, 'resume.pdf'), '%PDF-1.4 fake');
  fs.writeFileSync(path.join(acme, 'cover_letter.pdf'), '%PDF-1.4 fake');
  fs.writeFileSync(path.join(acme, 'fill_sheet.md'), SHEET);
  const globex = path.join(career, 'jobs/packets/2026-10-28-globex-ops-analyst');
  fs.mkdirSync(globex, { recursive: true });
  // A link that points outside the repo must never be opened.
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, 'outside/resume.pdf'), '%PDF secret');
  fs.symlinkSync(path.join(root, 'outside/resume.pdf'), path.join(globex, 'resume.pdf'));
  return { root, career, file: path.join(career, QUEUE_FILE), acme };
}

describe('reading the queue', () => {
  it('reads every item, counts by status and flags what is off without dropping it', () => {
    const { file } = repo();
    const q = readQueue(file);
    expect(q.counts).toEqual({ draft: 1, reviewed: 1, submitted: 1 });
    expect(queueSummary(q.counts)).toBe('1 draft · 1 reviewed · 1 submitted');
    expect(queueSummary({ draft: 2, reviewed: 1, submitted: 3 })).toBe('2 drafts · 1 reviewed · 3 submitted');
    const [acme, globex, initech] = q.items;
    expect(acme).toMatchObject({ company: 'Acme Energy', fit: 'possible', fitKnown: true, url: 'https://example.com/jobs/123', deadline: '2026-12-01', notes: null, problems: [] });
    expect(acme.files).toEqual({ resume: true, coverLetter: true, fillSheet: true });
    // Globex's resume.pdf is a link out of the repo: not offered.
    expect(globex.files).toEqual({ resume: false, coverLetter: false, fillSheet: false });
    expect(globex.submittedOn).toBe('2026-10-30');
    expect(initech).toMatchObject({ fit: 'great', fitKnown: false, url: null, files: { resume: false, coverLetter: false, fillSheet: false } });
    expect(initech.problems).toEqual(['unknown fit "great"', 'url is not an http(s) link', 'packet folder not found inside career: ../outside']);
  });

  it('an unknown status is kept and flagged; an item with no id is skipped and reported; empty and broken files', () => {
    const q = parseQueue('items:\n  - id: "a"\n    company: "A"\n    title: "T"\n    status: "applied"\n    added: "2026-11-01"\n    packet: "x"\n  - company: "No id"\n', '/r/jobs/queue/review_queue.yaml');
    expect(q.items[0]).toMatchObject({ status: 'applied', statusKnown: false });
    expect(q.items[0].problems).toContain('unknown status "applied"');
    expect(q.counts).toEqual({ draft: 0, reviewed: 0, submitted: 0 });
    expect(q.problems).toEqual(["Item 2 has no id, so it's skipped"]);
    expect(parseQueue('items: []\n', '/r/jobs/queue/review_queue.yaml').items).toEqual([]);
    expect(() => parseQueue('items: [\n', '/r/q.yaml')).toThrow(/not valid YAML/);
    expect(() => parseQueue('jobs: []\n', '/r/q.yaml')).toThrow(/items/);
  });

  it('packet folders must resolve inside the repo', () => {
    const { career, root } = repo();
    expect(packetDir(career, 'jobs/packets/2026-11-03-acme-energy-data-analyst-intern')).toBe(path.join(career, 'jobs/packets/2026-11-03-acme-energy-data-analyst-intern'));
    expect(packetDir(career, '../outside')).toBeNull();
    expect(packetDir(career, path.join(root, 'outside'))).toBeNull();
    expect(packetDir(career, 'jobs/packets/missing')).toBeNull();
    fs.symlinkSync(path.join(root, 'outside'), path.join(career, 'jobs/packets/sneaky'));
    expect(packetDir(career, 'jobs/packets/sneaky')).toBeNull();
  });

  it('display order: drafts, reviewed, submitted, unknown; soonest deadline first, none last', () => {
    const a = (status: string, deadline: string | null, added = '2026-11-01') => ({ status, deadline, added, id: `${status}-${deadline}` });
    const sorted = sortApplications([a('submitted', '2026-11-05'), a('draft', null), a('weird', '2026-11-01'), a('draft', '2026-12-01'), a('reviewed', null), a('draft', '2026-11-15')]);
    expect(sorted.map((x) => x.id)).toEqual(['draft-2026-11-15', 'draft-2026-12-01', 'draft-null', 'reviewed-null', 'submitted-2026-11-05', 'weird-2026-11-01']);
  });
});

describe('changing a status', () => {
  it('changes only that value, keeping its double quotes, comments and layout', () => {
    const out = setQueueStatus(QUEUE, 0, '2026-11-03-acme-energy-data-analyst-intern', 'reviewed', '2026-11-05');
    expect(out).toBe(QUEUE.replace('    status: "draft"\n', '    status: "reviewed"\n'));
  });

  it('submitted adds submitted_on under status; moving back removes it; an existing date is kept', () => {
    const sub = setQueueStatus(QUEUE, 0, '2026-11-03-acme-energy-data-analyst-intern', 'submitted', '2026-11-05');
    expect(sub).toBe(QUEUE.replace('    status: "draft"\n', '    status: "submitted"\n    submitted_on: "2026-11-05"\n'));
    const back = setQueueStatus(sub, 0, '2026-11-03-acme-energy-data-analyst-intern', 'draft', '2026-11-06');
    expect(back).toBe(QUEUE);
    const globexBack = setQueueStatus(QUEUE, 1, '2026-10-28-globex-ops-analyst', 'reviewed', '2026-11-05');
    expect(globexBack).toBe(
      QUEUE.replace('    status: "submitted"\n    fit: "strong"\n    added: "2026-10-28"\n    submitted_on: "2026-10-30"\n', '    status: "reviewed"\n    fit: "strong"\n    added: "2026-10-28"\n'),
    );
    // Re-saving submitted leaves its date alone.
    expect(setQueueStatus(QUEUE, 1, '2026-10-28-globex-ops-analyst', 'submitted', '2026-11-05')).toBe(QUEUE);
  });

  it('a comment after the value stays; plain values stay plain', () => {
    const text = 'items:\n  - id: a\n    status: draft  # set by career-hq\n    company: A\n';
    expect(setQueueStatus(text, 0, 'a', 'reviewed', '2026-11-05')).toBe('items:\n  - id: a\n    status: reviewed  # set by career-hq\n    company: A\n');
    expect(setQueueStatus(text, 0, 'a', 'submitted', '2026-11-05')).toBe('items:\n  - id: a\n    status: submitted  # set by career-hq\n    submitted_on: 2026-11-05\n    company: A\n');
  });

  it('refuses when the item moved, is a one-liner, or has no status', () => {
    expect(() => setQueueStatus(QUEUE, 0, 'someone-else', 'reviewed', '2026-11-05')).toThrow(/no longer/);
    expect(() => setQueueStatus('items:\n  - { id: a, status: draft }\n', 0, 'a', 'reviewed', '2026-11-05')).toThrow(/one line/);
    expect(() => setQueueStatus('items:\n  - id: a\n    company: A\n', 0, 'a', 'reviewed', '2026-11-05')).toThrow(/no plain status/);
  });

  it('writes only the version the page loaded, backs up once per run and keeps permissions', () => {
    const { file, root } = repo();
    fs.chmodSync(file, 0o600);
    const backupDir = path.join(root, 'backups');
    const backedUp = new Set<string>();
    const v1 = readQueue(file).version;
    const q = writeQueueStatus({ file, version: v1, index: 0, id: '2026-11-03-acme-energy-data-analyst-intern', status: 'reviewed', backupDir, backedUp });
    expect(q.counts).toEqual({ draft: 0, reviewed: 2, submitted: 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeQueueStatus({ file, version: v1, index: 0, id: '2026-11-03-acme-energy-data-analyst-intern', status: 'draft', backupDir, backedUp })).toThrow(/changed outside the hub/);
    writeQueueStatus({ file, version: q.version, index: 0, id: '2026-11-03-acme-energy-data-analyst-intern', status: 'draft', backupDir, backedUp });
    expect(fs.readdirSync(backupDir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]), 'utf8')).toBe(QUEUE);
    expect(fs.readFileSync(file, 'utf8')).toBe(QUEUE);
  });
});

describe('fill sheet', () => {
  it('keeps headings, fields, hints and notes in file order', () => {
    const s = parseFillSheet(SHEET);
    expect(s.title).toBe('Fill sheet — Acme Energy · Data Analyst Intern');
    expect(s.parts).toEqual([
      { type: 'text', text: 'Copy top to bottom. `[not in profile]` means it was never given.' },
      { type: 'heading', level: 2, text: '1. Personal info' },
      { type: 'field', label: 'First name', hint: null, value: 'Pat', missing: false },
      { type: 'field', label: 'GitHub', hint: null, value: '[not in profile]', missing: true },
      { type: 'heading', level: 2, text: '5. Work experience' },
      { type: 'heading', level: 3, text: 'Example Co — Intern' },
      { type: 'field', label: 'Description', hint: '(58 characters)', value: '- Built a dashboard\n- Cleaned survey data for 3 teams', missing: false },
      { type: 'note', text: 'Role wording not approved yet.\nAsk before using it.' },
    ]);
  });
});

describe('API and launches', () => {
  function setup() {
    const r = repo();
    const db = openDb(path.join(r.root, 'hub.db'), MIGRATIONS_DIR);
    const t = testDeps(db);
    cleanups.push(() => t.files.close());
    fs.writeFileSync(t.projectsFile, `projects:\n  - slug: career\n    name: Career HQ\n    repos: [${r.career}]\n  - slug: other\n    name: Other\n    folders: [${r.root}/outside]\n`);
    t.store.reload();
    const app = createApp({ ...t.deps, home: r.root });
    const page = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    const call = async (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
      const res = await app.request(`${HUB}${url}`, { method, headers: headers ?? (method === 'GET' ? PAGE_GET : page), body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') };
    };
    return { ...r, t, call };
  }

  it('the queue and a fill sheet need the page token and are never cached', async () => {
    const { call } = setup();
    const q = await call('GET', '/api/projects/career/applications');
    expect(q.status).toBe(200);
    expect(q.cache).toBe('no-store');
    expect(q.body.items).toHaveLength(3);
    expect((await call('GET', '/api/projects/career/applications', undefined, {})).status).toBe(403);
    expect((await call('GET', '/api/projects/other/applications')).status).toBe(404);
    const sheet = await call('GET', '/api/projects/career/applications/2026-11-03-acme-energy-data-analyst-intern/fill-sheet');
    expect(sheet.cache).toBe('no-store');
    expect(sheet.body).toMatchObject({ company: 'Acme Energy', role: 'Data Analyst Intern' });
    expect(sheet.body.parts.filter((p: { type: string }) => p.type === 'field')).toHaveLength(3);
    expect((await call('GET', '/api/projects/career/applications/2026-10-28-globex-ops-analyst/fill-sheet')).status).toBe(404);
    expect((await call('GET', '/api/projects/career/applications/not-there/fill-sheet')).status).toBe(404);
    expect((await call('GET', '/api/projects/career/applications/2026-11-03-acme-energy-data-analyst-intern/fill-sheet', undefined, {})).status).toBe(403);
  });

  it('the card says "Applications: 1 draft · 1 reviewed · 1 submitted"', async () => {
    const { call } = setup();
    const projects = (await call('GET', '/api/projects')).body;
    expect(projects.find((p: { slug: string }) => p.slug === 'career').applications).toEqual({ summary: '1 draft · 1 reviewed · 1 submitted', total: 3, error: null });
    expect(projects.find((p: { slug: string }) => p.slug === 'other').applications).toBeNull();
  });

  it('a status change writes back; a stale page gets 409 with the current queue; only the hub page may write', async () => {
    const { call, file } = setup();
    const { version } = (await call('GET', '/api/projects/career/applications')).body;
    const ok = await call('PUT', '/api/projects/career/applications/2', { id: '2026-11-01-initech-intern', status: 'submitted', version });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toContain('    status: "submitted"\n    submitted_on: "');
    const stale = await call('PUT', '/api/projects/career/applications/0', { id: '2026-11-03-acme-energy-data-analyst-intern', status: 'reviewed', version });
    expect(stale.status).toBe(409);
    expect(stale.body.current.counts).toEqual({ draft: 1, reviewed: 0, submitted: 2 });
    expect((await call('PUT', '/api/projects/career/applications/0', { id: 'x', status: 'applied', version })).status).toBe(400);
    const noOrigin = await call('PUT', '/api/projects/career/applications/0', { id: '2026-11-03-acme-energy-data-analyst-intern', status: 'reviewed', version: ok.body.version }, { 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' });
    expect(noOrigin.status).toBe(403);
  });

  it('opens only PDFs of listed applications, inside the repo, always in Preview', async () => {
    const { call, acme } = setup();
    const launch = (body: object) => call('POST', '/api/launch', { ...body, dryRun: true });
    expect((await launch({ kind: 'packet-file', slug: 'career', id: '2026-11-03-acme-energy-data-analyst-intern', file: 'resume' })).body.command).toBe(`open -a Preview ${path.join(acme, 'resume.pdf')}`);
    expect((await launch({ kind: 'packet-file', slug: 'career', id: '2026-11-03-acme-energy-data-analyst-intern', file: 'cover-letter' })).body.command).toBe(`open -a Preview ${path.join(acme, 'cover_letter.pdf')}`);
    // Not in the queue, a packet outside the repo, a link pointing out, no queue at all, or an unknown file kind.
    expect((await launch({ kind: 'packet-file', slug: 'career', id: 'not-listed', file: 'resume' })).status).toBe(404);
    expect((await launch({ kind: 'packet-file', slug: 'career', id: '2026-11-01-initech-intern', file: 'resume' })).status).toBe(404);
    expect((await launch({ kind: 'packet-file', slug: 'career', id: '2026-10-28-globex-ops-analyst', file: 'resume' })).status).toBe(404);
    expect((await launch({ kind: 'packet-file', slug: 'other', id: '2026-11-03-acme-energy-data-analyst-intern', file: 'resume' })).status).toBe(404);
    expect((await launch({ kind: 'packet-file', slug: 'career', id: '2026-11-03-acme-energy-data-analyst-intern', file: 'fill_sheet.md' })).status).toBe(400);
    expect((await launch({ kind: 'packet-file', slug: 'career', id: '2026-11-03-acme-energy-data-analyst-intern', file: 'resume', path: '/etc/passwd' })).body.command).toBe(`open -a Preview ${path.join(acme, 'resume.pdf')}`); // extra fields are ignored
    // Same Phase 2 checks as every launch: page token and Origin.
    expect((await call('POST', '/api/launch', { kind: 'packet-file', slug: 'career', id: '2026-11-03-acme-energy-data-analyst-intern', file: 'resume', dryRun: true }, { 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' })).status).toBe(403);
  });

  it('none of it reaches the MCP tools', async () => {
    const { call } = setup();
    for (const url of ['/agent/v1/projects', '/agent/v1/projects/career']) {
      const res = await call('GET', url, undefined, { 'X-Agent-Token': AGENT_TOKEN });
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/applications|Acme|Globex|fill.?sheet|review_queue/i);
    }
  });
});

describe('watching the queue file', () => {
  it('a folder that does not exist yet never throws, and the file is noticed once it appears', async () => {
    const root = tmp();
    const file = path.join(root, QUEUE_FILE); // jobs/queue/ doesn't exist
    let changes = 0;
    const w = watchFile(file, () => changes++, 50);
    cleanups.push(() => w.close());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'items: []\n');
    const end = Date.now() + 3000;
    while (changes === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(changes).toBeGreaterThan(0);
  });
});

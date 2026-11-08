// Applications: Career HQ's review queue, fill sheets (JSON and Markdown), the
// status command and PDF launches.
// All data here is made up; no real queue or fill sheet is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findQueueFiles, limitFlags, packetDir, parseFillSheet, parseFillSheetJson, parseQueue, QUEUE_FILES, queueRoot, queueSummary, readFillSheet, readQueue, sortApplications } from '../src/server/applications.ts';
import { limitSummary, sha256Hex } from '../src/server/queue-rules.ts';
import { approveDraft, changeQueueStatus, copyCommand } from '../src/server/queue-status.ts';
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

const QUEUE = `# Written by career-hq. Project Hub reads it.
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
  fs.mkdirSync(path.join(career, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(career, QUEUE_FILES[0]), QUEUE);
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
  return { root, career, file: path.join(career, QUEUE_FILES[0]), acme };
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
      { type: 'field', label: 'Description', hint: null, value: '- Built a dashboard\n- Cleaned survey data for 3 teams', missing: false, count: { length: 53, chars: 58, max: null, over: false, overStale: false } },
      { type: 'note', text: 'Role wording not approved yet.\nAsk before using it.' },
    ]);
  });
});

/**
 * A stand-in for uv: records its folder, arguments and environment, then acts
 * by the `mode` file next to it (ok: puts after.yaml in place as the queue;
 * fail: exits 1 with a message; noop: changes nothing; slow: sleeps;
 * approve: puts after.json in place at the path in `target` and prints Career
 * HQ's one line; refuse: prints an "error:" line and exits 2).
 */
const FAKE_UV = `#!/bin/sh
d=$(dirname "$0")
printf '%s\\n' "$PWD" "$@" > "$d/args"
env > "$d/env"
case $(cat "$d/mode") in
  ok) cp "$d/after.yaml" jobs/queue.yaml; echo "changed";;
  fail) echo "starting" ; echo "No packet for that id" >&2; exit 1;;
  noop) echo "nothing to do";;
  slow) sleep 5;;
  approve) cp "$d/after.json" "$(cat "$d/target")"; echo "$5 question $6: draft approved (5 / 50 characters)";;
  refuse) echo "checking" ; echo "error: the draft for question $6 has changed since it was shown; reload and try again" >&2; exit 2;;
esac
`;

type FakeMode = 'ok' | 'fail' | 'noop' | 'slow' | 'approve' | 'refuse';
function fakeUv(root: string, mode: FakeMode, after?: string) {
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'uv'), FAKE_UV, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mode'), mode);
  if (after !== undefined) fs.writeFileSync(path.join(bin, 'after.yaml'), after);
  const read = (f: string) => fs.readFileSync(path.join(bin, f), 'utf8');
  return { bin, uv: path.join(bin, 'uv'), args: () => read('args').trimEnd().split('\n'), env: () => read('env'), ran: () => fs.existsSync(path.join(bin, 'args')) };
}

function setup(withUv?: { mode: FakeMode; after?: string; script?: boolean }) {
  const r = repo();
  if (withUv?.script !== false) {
    fs.mkdirSync(path.join(r.career, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(r.career, 'scripts/review_queue.py'), '# stand-in; the fake uv never runs it\n');
  }
  const fake = withUv ? fakeUv(r.root, withUv.mode, withUv.after) : null;
  const overrides = fake ? { uvPath: fake.uv } : {};
  const db = openDb(path.join(r.root, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db);
  cleanups.push(() => t.files.close());
  fs.writeFileSync(t.projectsFile, `projects:\n  - slug: career\n    name: Career HQ\n    repos: [${r.career}]\n  - slug: other\n    name: Other\n    folders: [${r.root}/outside]\n`);
  t.store.reload();
  const app = createApp({ ...t.deps, home: r.root, ...overrides });
  const page = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
  const call = async (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
    const res = await app.request(`${HUB}${url}`, { method, headers: headers ?? (method === 'GET' ? PAGE_GET : page), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') };
  };
  return { ...r, t, call, fake };
}

describe('API and launches', () => {

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
    const file = path.join(root, QUEUE_FILES[1]); // jobs/queue/ doesn't exist
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

describe('where the queue lives', () => {
  it('jobs/queue.yaml, or the older jobs/queue/review_queue.yaml; with both, the newer one first', () => {
    const { career } = repo();
    const p = { repos: [career], folders: [] };
    expect(findQueueFiles(p)).toEqual([path.join(career, 'jobs/queue.yaml')]);
    const older = path.join(career, 'jobs/queue/review_queue.yaml');
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.writeFileSync(older, 'items: []\n');
    fs.utimesSync(path.join(career, 'jobs/queue.yaml'), new Date('2026-11-01'), new Date('2026-11-01'));
    expect(findQueueFiles(p)).toEqual([older, path.join(career, 'jobs/queue.yaml')]);
    fs.rmSync(path.join(career, 'jobs/queue.yaml'));
    expect(findQueueFiles(p)).toEqual([older]);
    // Packet paths are relative to the repo either way.
    expect(queueRoot(path.join(career, 'jobs/queue.yaml'))).toBe(career);
    expect(queueRoot(older)).toBe(career);
  });

  it('the page is told about a second queue file it is not showing', async () => {
    const { call, career } = setup();
    const older = path.join(career, 'jobs/queue/review_queue.yaml');
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.writeFileSync(older, 'items: []\n');
    fs.utimesSync(older, new Date('2026-11-01'), new Date('2026-11-01'));
    const q = (await call('GET', '/api/projects/career/applications')).body;
    expect(q.file).toBe(path.join(career, 'jobs/queue.yaml'));
    expect(q.others).toEqual([older]);
  });
});

// Fictional, in the shape SPEC.md "Fill sheet JSON" gives.
const SHEET_JSON = {
  format: 'career-hq fill sheet',
  version: 1,
  id: '2026-11-03-acme-energy-data-analyst-intern',
  company: 'Acme Energy',
  title: 'Data Analyst Intern',
  generated: '2026-11-03',
  missing_marker: '[not in profile]',
  sections: [
    { heading: '1. Personal info', notes: [], fields: [{ label: 'First name', value: 'Pat' }, { label: 'GitHub', value: '[not in profile]' }] },
    {
      heading: '5. Work experience',
      notes: [{ text: 'Most recent first.', group: null }, { text: 'Wording not approved yet.', group: 'Example Co — Intern' }],
      fields: [
        { label: 'Employer', value: 'Example Co', group: 'Example Co — Intern' },
        { label: 'Description', value: '- Built a dashboard\n- Cleaned data', group: 'Example Co — Intern', chars: 34 },
        { label: 'Employer', value: 'Other Ltd', group: 'Other Ltd — Clerk' },
        { label: 'Description', value: 'Filed things ✓', group: 'Other Ltd — Clerk', chars: 99 },
      ],
    },
    {
      heading: '9. Job-specific questions',
      notes: [],
      fields: [
        { label: 'Why us?', value: 'Because.', chars: 8, max_chars: 500 },
        { label: 'In one line', value: 'x'.repeat(130), chars: 130, max_chars: 120, over_limit: true },
      ],
    },
    { heading: '10. Answer yourself', notes: [{ text: 'Salary expectations', group: null }, { text: 'References', group: 'Ask first' }], fields: [] },
  ],
};

describe('fill sheet JSON', () => {
  it('keeps sections, groups and notes in order; notes and missing values have no copy value; counts and limits', () => {
    const { parts, warnings } = parseFillSheetJson(JSON.stringify(SHEET_JSON));
    expect(warnings).toEqual([]);
    expect(parts).toEqual([
      { type: 'heading', level: 2, text: '1. Personal info' },
      { type: 'field', label: 'First name', hint: null, value: 'Pat', missing: false },
      { type: 'field', label: 'GitHub', hint: null, value: '[not in profile]', missing: true },
      { type: 'heading', level: 2, text: '5. Work experience' },
      { type: 'note', text: 'Most recent first.' },
      { type: 'heading', level: 3, text: 'Example Co — Intern' },
      { type: 'note', text: 'Wording not approved yet.' },
      { type: 'field', label: 'Employer', hint: null, value: 'Example Co', missing: false },
      { type: 'field', label: 'Description', hint: null, value: '- Built a dashboard\n- Cleaned data', missing: false, count: { length: 34, chars: 34, max: null, over: false, overStale: false } },
      { type: 'heading', level: 3, text: 'Other Ltd — Clerk' },
      { type: 'field', label: 'Employer', hint: null, value: 'Other Ltd', missing: false },
      // ✓ is one character, as Career HQ counts; the file's 99 is stale and shown as such.
      { type: 'field', label: 'Description', hint: null, value: 'Filed things ✓', missing: false, count: { length: 14, chars: 99, max: null, over: false, overStale: false } },
      { type: 'heading', level: 2, text: '9. Job-specific questions' },
      { type: 'field', label: 'Why us?', hint: null, value: 'Because.', missing: false, count: { length: 8, chars: 8, max: 500, over: false, overStale: false } },
      { type: 'field', label: 'In one line', hint: null, value: 'x'.repeat(130), missing: false, count: { length: 130, chars: 130, max: 120, over: true, overStale: false } },
      { type: 'heading', level: 2, text: '10. Answer yourself' },
      { type: 'note', text: 'Salary expectations' },
      { type: 'heading', level: 3, text: 'Ask first' },
      { type: 'note', text: 'References' },
    ]);
  });

  it('a custom missing_marker; an unknown version is read with a warning; a wrong format is refused', () => {
    const custom = { ...SHEET_JSON, missing_marker: 'TODO', sections: [{ heading: 'A', notes: [], fields: [{ label: 'X', value: 'TODO' }, { label: 'Y', value: '[not in profile]' }] }] };
    expect(parseFillSheetJson(JSON.stringify(custom)).parts.slice(1).map((p) => p.type === 'field' && p.missing)).toEqual([true, false]);
    expect(parseFillSheetJson(JSON.stringify({ ...SHEET_JSON, version: 2 })).warnings).toEqual([expect.stringMatching(/version 2; this hub knows version 1/)]);
    expect(() => parseFillSheetJson('{')).toThrow(/not valid JSON/);
    expect(() => parseFillSheetJson(JSON.stringify({ ...SHEET_JSON, format: 'something else' }))).toThrow(/doesn't match the format: format/);
    expect(() => parseFillSheetJson(JSON.stringify({ ...SHEET_JSON, sections: [{ heading: 'A', fields: [{ label: 'X' }] }] }))).toThrow(/sections\.0\.fields\.0\.value/);
  });

  it('read through the packet path: JSON first, Markdown when there is none or it is broken, with warnings', () => {
    const { file, acme, root } = repo();
    const id = '2026-11-03-acme-energy-data-analyst-intern';
    const json = path.join(acme, 'fill_sheet.json');
    expect(readFillSheet(file, id)).toMatchObject({ source: 'md', warnings: [] });
    fs.writeFileSync(json, JSON.stringify(SHEET_JSON));
    expect(readFillSheet(file, id)).toMatchObject({ source: 'json', generated: '2026-11-03', warnings: [], company: 'Acme Energy', role: 'Data Analyst Intern' });
    fs.writeFileSync(json, JSON.stringify({ ...SHEET_JSON, id: '2026-01-01-someone-else' }));
    expect(readFillSheet(file, id).warnings).toEqual([expect.stringMatching(/says it is for "2026-01-01-someone-else"/)]);
    fs.writeFileSync(json, '{"format": "career-hq fill sheet"');
    expect(readFillSheet(file, id)).toMatchObject({ source: 'md', warnings: [expect.stringMatching(/not valid JSON.*so this is fill_sheet\.md instead/)] });
    fs.writeFileSync(json, JSON.stringify({ ...SHEET_JSON, pad: 'x'.repeat(1024 * 1024) }));
    expect(readFillSheet(file, id)).toMatchObject({ source: 'md', warnings: [expect.stringMatching(/over 1 MB/)] });
    fs.rmSync(path.join(acme, 'fill_sheet.md'));
    expect(() => readFillSheet(file, id)).toThrow(/over 1 MB, and there is no fill_sheet\.md/);
    // A fill_sheet.json that links out of the repo is never read.
    fs.writeFileSync(path.join(root, 'outside/fill_sheet.json'), JSON.stringify(SHEET_JSON));
    fs.rmSync(json);
    fs.symlinkSync(path.join(root, 'outside/fill_sheet.json'), json);
    expect(() => readFillSheet(file, id)).toThrow(/No fill sheet/);
  });

  it('served the same way: page token only, never cached, and a card offers it when only the JSON exists', async () => {
    const { call, acme } = setup();
    fs.rmSync(path.join(acme, 'fill_sheet.md'));
    fs.writeFileSync(path.join(acme, 'fill_sheet.json'), JSON.stringify(SHEET_JSON));
    const q = (await call('GET', '/api/projects/career/applications')).body;
    expect(q.items[0].files.fillSheet).toBe(true);
    const url = '/api/projects/career/applications/2026-11-03-acme-energy-data-analyst-intern/fill-sheet';
    const sheet = await call('GET', url);
    expect(sheet.cache).toBe('no-store');
    expect(sheet.body.source).toBe('json');
    expect((await call('GET', url, undefined, {})).status).toBe(403);
    for (const agent of ['/agent/v1/projects', '/agent/v1/projects/career']) {
      expect(JSON.stringify((await call('GET', agent, undefined, { 'X-Agent-Token': AGENT_TOKEN })).body)).not.toMatch(/Example Co|\bPat\b|fill.?sheet|queue|applications/i);
    }
  });
});

describe("status changes run Career HQ's command", () => {
  const ID = '2026-11-03-acme-energy-data-analyst-intern';
  const AFTER = QUEUE.replace('status: "draft"', 'status: "reviewed"');
  const body = (version: string, extra: object = {}) => ({ kind: 'queue-status', slug: 'career', id: ID, status: 'reviewed', version, ...extra });
  const version = async (call: ReturnType<typeof setup>['call']) => (await call('GET', '/api/projects/career/applications')).body.version as string;

  it('dryRun shows the exact command; nothing runs', async () => {
    const { call, career, fake } = setup({ mode: 'ok', after: AFTER });
    const res = await call('POST', '/api/launch', body(await version(call), { dryRun: true }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, cwd: career, argv: [fake!.uv, 'run', 'python', 'scripts/review_queue.py', 'status', ID, 'reviewed'] });
    expect(res.body.command).toBe(`cd ~/career && uv run python scripts/review_queue.py status ${ID} reviewed`);
    expect(fake!.ran()).toBe(false);
  });

  it('runs it in the repo with only those arguments and a minimal environment, then returns the updated queue', async () => {
    process.env.PROJECT_HUB_TEST_SECRET = 'do-not-pass';
    cleanups.push(() => delete process.env.PROJECT_HUB_TEST_SECRET);
    const { call, career, fake, file } = setup({ mode: 'ok', after: AFTER });
    const res = await call('POST', '/api/launch', body(await version(call)));
    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(res.body.queue.counts).toEqual({ draft: 0, reviewed: 2, submitted: 1 });
    expect(fake!.args()).toEqual([career, 'run', 'python', 'scripts/review_queue.py', 'status', ID, 'reviewed']);
    expect(fake!.env()).not.toContain('PROJECT_HUB_TEST_SECRET');
    expect(fake!.env()).toContain('NO_COLOR=1');
    expect(fs.readFileSync(file, 'utf8')).toBe(AFTER);
  });

  it('a failure shows its output and the command to copy; so does a run that changes nothing', async () => {
    const failed = setup({ mode: 'fail' });
    const res = await failed.call('POST', '/api/launch', body(await version(failed.call)));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Career HQ's status command failed (exit 1)",
      output: 'No packet for that id\nstarting',
      command: `cd ~/career && uv run python scripts/review_queue.py status ${ID} reviewed`,
    });
    const noop = setup({ mode: 'noop' });
    const res2 = await noop.call('POST', '/api/launch', body(await version(noop.call)));
    expect(res2.status).toBe(500);
    expect(res2.body).toMatchObject({ error: 'The command finished, but the queue still shows "draft"', output: 'nothing to do', command: expect.stringContaining('status 2026-11-03') });
  });

  it('refuses before running: unknown or odd ids, bad status, a stale page, no script, a script linked outside, no uv', async () => {
    const { call, fake, career, root } = setup({ mode: 'ok', after: AFTER });
    const v = await version(call);
    const post = (b: object) => call('POST', '/api/launch', b);
    expect((await post(body(v, { id: '2026-01-01-not-listed' }))).status).toBe(404);
    for (const id of ['x; rm -rf ~', '2026-11-03-Acme', '--help', '2026-11-03-acme energy', '2026-11-03-acme-energy-data-analyst-intern\n']) expect((await post(body(v, { id }))).status).toBe(400);
    expect((await post(body(v, { status: 'applied' }))).status).toBe(400);
    expect((await post(body('0'.repeat(64)))).status).toBe(409);
    const stale = await post(body('0'.repeat(64)));
    expect(stale.body.current.counts).toEqual({ draft: 1, reviewed: 1, submitted: 1 });
    expect((await post({ ...body(v), slug: 'other' })).status).toBe(404);
    // Phase 2 checks: no Origin, or no token.
    expect((await call('POST', '/api/launch', body(v), { 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' })).status).toBe(403);
    expect((await call('POST', '/api/launch', body(v), { Origin: HUB, 'Content-Type': 'application/json' })).status).toBe(403);
    expect(fake!.ran()).toBe(false);

    const script = path.join(career, 'scripts/review_queue.py');
    fs.rmSync(script);
    expect((await post(body(v))).body).toMatchObject({ error: 'No scripts/review_queue.py inside ~/career', command: expect.any(String) });
    fs.writeFileSync(path.join(root, 'outside/review_queue.py'), '');
    fs.symlinkSync(path.join(root, 'outside/review_queue.py'), script);
    expect((await post(body(v))).status).toBe(409);
    expect(fake!.ran()).toBe(false);

    const noUv = setup();
    const res = await noUv.call('POST', '/api/launch', body(await version(noUv.call)));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/uv isn't at/);
  });

  it('a run that takes too long is stopped; one run per project at a time', async () => {
    const { fake, root } = setup({ mode: 'slow' });
    const p = { slug: 'career', repos: [path.join(root, 'career')], folders: [] } as never;
    const v = readQueue(path.join(root, 'career/jobs/queue.yaml')).version;
    const req = { kind: 'queue-status' as const, slug: 'career', id: ID, status: 'reviewed' as const, version: v };
    const deps = { project: () => p, uvPath: fake!.uv, home: root, running: new Set<string>(), timeoutMs: 300 };
    const res = await changeQueueStatus(req, deps);
    expect(res).toMatchObject({ status: 500, body: { error: "The command didn't finish within 0.3 seconds, so it was stopped" } });
    const busy = await changeQueueStatus(req, { ...deps, running: new Set(['career']) });
    expect(busy).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already running/) } });
  });

  it('the copyable command uses ~ and quotes odd folder names', () => {
    expect(copyCommand('/Users/me/career-hq', ['status', ID, 'submitted'], '/Users/me')).toBe(`cd ~/career-hq && uv run python scripts/review_queue.py status ${ID} submitted`);
    expect(copyCommand('/Users/me/My Career', ['status', ID, 'draft'], '/Users/me')).toBe(`cd ~/'My Career' && uv run python scripts/review_queue.py status ${ID} draft`);
    expect(copyCommand('/opt/career', ['status', ID, 'draft'], '/Users/me')).toBe(`cd /opt/career && uv run python scripts/review_queue.py status ${ID} draft`);
  });
});

describe('limits and shorter drafts', () => {
  const field = (extra: object) => ({ label: 'Why us?', value: 'y'.repeat(60), chars: 60, max_chars: 50, over_limit: true, ...extra });
  const sheet = (...fields: object[]) => JSON.stringify({ ...SHEET_JSON, sections: [{ heading: '9. Job-specific questions', notes: [], fields }] });
  const fields = (text: string) => parseFillSheetJson(text).parts.filter((p) => p.type === 'field');

  it('reads over_limit and shorter_draft: a draft that fits, one still over, and none yet', () => {
    const [fits, stillOver, none, ok] = fields(
      sheet(
        field({ shorter_draft: { value: 'short', chars: 5, status: 'pending approval' } }),
        field({ shorter_draft: { value: 'z'.repeat(55), chars: 55, status: 'pending approval', over_limit: true } }),
        field({}),
        { label: 'Fine', value: 'ok', chars: 2, max_chars: 50 },
      ),
    );
    expect(fits).toMatchObject({ count: { length: 60, max: 50, over: true, overStale: false }, draft: { value: 'short', status: 'pending approval', count: { length: 5, max: 50, over: false, overStale: false } } });
    expect(stillOver).toMatchObject({ draft: { count: { length: 55, max: 50, over: true, overStale: false } } });
    expect(none).toMatchObject({ count: { over: true } });
    expect(none).not.toHaveProperty('draft');
    expect(ok).toMatchObject({ count: { over: false, overStale: false } });
    expect(ok).not.toHaveProperty('draft');
    expect(limitFlags(parseFillSheetJson(sheet(field({ shorter_draft: { value: 'a', chars: 1, status: 'pending approval' } }), field({}))).parts)).toEqual({ over: 2, drafts: 1 });
    expect(limitSummary({ over: 2, drafts: 1 })).toBe('2 fields over their limit · 1 shorter draft pending your approval');
    expect(limitSummary({ over: 1, drafts: 0 })).toBe('1 field over its limit');
    expect(limitSummary({ over: 0, drafts: 0 })).toBeNull();
  });

  it("Career HQ's flag and the hub's count disagreeing is flagged; over_limit alone still counts as over", () => {
    const [saysOverButFits, saysFineButOver, flagOnly] = fields(
      sheet({ label: 'A', value: 'abc', chars: 3, max_chars: 50, over_limit: true }, { label: 'B', value: 'b'.repeat(60), chars: 60, max_chars: 50 }, { label: 'C', value: 'c', chars: 1, over_limit: true }),
    );
    expect(saysOverButFits).toMatchObject({ count: { over: true, overStale: true } });
    expect(saysFineButOver).toMatchObject({ count: { over: true, overStale: true } });
    expect(flagOnly).toMatchObject({ count: { max: null, over: true, overStale: false } });
  });

  it('fill_sheet.md shows the same: limits, the OVER THE LIMIT note and the pending draft become counts and a draft', () => {
    const md = [
      '## 9. Job-specific questions',
      '',
      '**Why us?** (60 / 50 characters max)',
      '```',
      'y'.repeat(60),
      '```',
      '',
      "> **OVER THE LIMIT** by 10 characters. Don't paste the version above as-is.",
      '',
      '**Shorter draft, pending your approval** (55 / 50 characters max) **still over the limit**',
      '```',
      'z'.repeat(55),
      '```',
      '',
      '**Why now?** (70 / 50 characters max)',
      '```',
      'w'.repeat(70),
      '```',
      '',
      "> **OVER THE LIMIT** by 20 characters. Don't paste the version above as-is.",
      '> No shorter version drafted yet. Ask for one (same facts, fewer words).',
      '',
      '**Fine** (2 / 50 characters max)',
      '```',
      'ok',
      '```',
    ].join('\n');
    expect(parseFillSheet(md).parts).toEqual([
      { type: 'heading', level: 2, text: '9. Job-specific questions' },
      {
        type: 'field', label: 'Why us?', hint: null, value: 'y'.repeat(60), missing: false,
        count: { length: 60, chars: 60, max: 50, over: true, overStale: false },
        draft: { value: 'z'.repeat(55), status: 'pending approval', question: null, count: { length: 55, chars: 55, max: 50, over: true, overStale: false } },
      },
      { type: 'field', label: 'Why now?', hint: null, value: 'w'.repeat(70), missing: false, count: { length: 70, chars: 70, max: 50, over: true, overStale: false } },
      { type: 'field', label: 'Fine', hint: null, value: 'ok', missing: false, count: { length: 2, chars: 2, max: 50, over: false, overStale: false } },
    ]);
  });

  it("the application's card carries the counts, from the API and after a status change", async () => {
    const { call, acme } = setup({ mode: 'ok', after: QUEUE.replace('status: "draft"', 'status: "reviewed"') });
    fs.writeFileSync(path.join(acme, 'fill_sheet.json'), sheet(field({ shorter_draft: { value: 'short', chars: 5, status: 'pending approval' } }), field({})));
    const q = (await call('GET', '/api/projects/career/applications')).body;
    expect(q.items[0].limits).toEqual({ over: 2, drafts: 1 });
    expect(q.items[1].limits).toBeNull();
    const res = await call('POST', '/api/launch', { kind: 'queue-status', slug: 'career', id: q.items[0].id, status: 'reviewed', version: q.version });
    expect(res.body.queue.items[0].limits).toEqual({ over: 2, drafts: 1 });
    // Still nothing for the MCP tools.
    for (const agent of ['/agent/v1/projects', '/agent/v1/projects/career']) {
      expect(JSON.stringify((await call('GET', agent, undefined, { 'X-Agent-Token': AGENT_TOKEN })).body)).not.toMatch(/limits|draft|over_limit|Why us/i);
    }
  });
});

describe('approving a shorter draft', () => {
  const ID = '2026-11-03-acme-energy-data-analyst-intern';
  const DRAFT = 'Short.\n  Kept as-is ✓ ';
  const withDraft = (draft: object) =>
    JSON.stringify({
      ...SHEET_JSON,
      sections: [
        {
          heading: '9. Job-specific questions',
          notes: [],
          fields: [
            { label: 'Why us?', value: 'y'.repeat(60), chars: 60, max_chars: 50, over_limit: true, shorter_draft: { question: 2, value: DRAFT, chars: [...DRAFT].length, status: 'pending approval', ...draft } },
          ],
        },
      ],
    });
  const APPROVED = JSON.stringify({ ...SHEET_JSON, sections: [{ heading: '9. Job-specific questions', notes: [], fields: [{ label: 'Why us?', value: DRAFT, chars: [...DRAFT].length, max_chars: 50 }] }] });
  async function ready(mode: FakeMode) {
    const s = setup({ mode, after: undefined });
    fs.writeFileSync(path.join(s.acme, 'fill_sheet.json'), withDraft({}));
    fs.writeFileSync(path.join(s.fake!.bin, 'after.json'), APPROVED);
    fs.writeFileSync(path.join(s.fake!.bin, 'target'), path.join(s.acme, 'fill_sheet.json'));
    const sheet = (await s.call('GET', `/api/projects/career/applications/${ID}/fill-sheet`)).body;
    const draft = sheet.parts.find((p: { draft?: unknown }) => p.draft).draft;
    return { ...s, draft, sha: await sha256Hex(draft.value) };
  }
  const body = (sha: string, extra: object = {}) => ({ kind: 'approve-draft', slug: 'career', id: ID, question: 2, sha256: sha, ...extra });

  it("the page's hash is SHA-256 of the exact UTF-8 bytes: newlines, spaces and non-ASCII kept", async () => {
    const crypto = await import('node:crypto');
    for (const text of [DRAFT, 'a\r\nb\n', '  padded  ', 'émoji 🚀 — dash', '']) {
      expect(await sha256Hex(text)).toBe(crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    }
  });

  it('reads the question number; only JSON drafts carry one', async () => {
    const { draft } = await ready('approve');
    expect(draft).toEqual({ value: DRAFT, question: 2, status: 'pending approval', count: { length: [...DRAFT].length, chars: [...DRAFT].length, max: 50, over: false, overStale: false } });
    expect(parseFillSheetJson(withDraft({ question: undefined })).parts.find((p) => p.type === 'field' && p.draft)).toMatchObject({ draft: { question: null } });
  });

  it('dryRun shows the exact command; a run passes separate arguments, then reports the one line and the reloaded queue', async () => {
    const { call, career, fake, sha, acme } = await ready('approve');
    const dry = await call('POST', '/api/launch', body(sha, { dryRun: true }));
    expect(dry.body).toMatchObject({ dryRun: true, cwd: career, argv: [fake!.uv, 'run', 'python', 'scripts/review_queue.py', 'approve-draft', ID, '2', sha] });
    expect(dry.body.command).toBe(`cd ~/career && uv run python scripts/review_queue.py approve-draft ${ID} 2 ${sha}`);
    expect(fake!.ran()).toBe(false);
    const res = await call('POST', '/api/launch', body(sha));
    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(res.body.message).toBe(`${ID} question 2: draft approved (5 / 50 characters)`);
    expect(res.body.queue.items[0].limits).toEqual({ over: 0, drafts: 0 });
    expect(fake!.args()).toEqual([career, 'run', 'python', 'scripts/review_queue.py', 'approve-draft', ID, '2', sha]);
    expect(fs.readFileSync(path.join(acme, 'fill_sheet.json'), 'utf8')).toBe(APPROVED);
  });

  it('a refusal shows its error: line and the command to copy; a run that leaves the draft is a failure', async () => {
    const { call, sha } = await ready('refuse');
    const res = await call('POST', '/api/launch', body(sha));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('error: the draft for question 2 has changed since it was shown; reload and try again (exit 2)');
    expect(res.body.command).toBe(`cd ~/career && uv run python scripts/review_queue.py approve-draft ${ID} 2 ${sha}`);
    const noop = await ready('noop');
    const res2 = await noop.call('POST', '/api/launch', body(noop.sha));
    expect(res2.status).toBe(500);
    expect(res2.body.error).toMatch(/still shows that draft/);
  });

  it('refuses before running: odd ids, question numbers and hashes, unknown ids, no Origin or token, one already running', async () => {
    const { call, fake, sha, root, career } = await ready('approve');
    const post = (b: object, headers?: Record<string, string>) => call('POST', '/api/launch', b, headers);
    for (const id of ['../x', '2026-11-03-acme/', '2026-11-03-Acme', '2026-11-03-acme ', 'x;rm -rf ~']) expect((await post(body(sha, { id }))).status).toBe(400);
    for (const question of [0, -1, 1.5, '2', '02', '²', 10000, null]) expect((await post(body(sha, { question }))).status).toBe(400);
    for (const s of [sha.toUpperCase(), sha.slice(1), `${sha}0`, 'z'.repeat(64), '']) expect((await post(body(s))).status).toBe(400);
    expect((await post(body(sha, { id: '2026-01-01-not-listed' }))).status).toBe(404);
    expect((await post(body(sha), { 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' })).status).toBe(403);
    expect((await post(body(sha), { Origin: HUB, 'Content-Type': 'application/json' })).status).toBe(403);
    expect(fake!.ran()).toBe(false);
    const p = { slug: 'career', repos: [career], folders: [] } as never;
    const busy = await approveDraft({ kind: 'approve-draft', slug: 'career', id: ID, question: 2, sha256: sha }, { project: () => p, uvPath: fake!.uv, home: root, running: new Set(['career']) });
    expect(busy).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already running/) } });
    expect(fake!.ran()).toBe(false);
  });

  it('none of it reaches the MCP tools', async () => {
    const { call } = await ready('approve');
    for (const agent of ['/agent/v1/projects', '/agent/v1/projects/career']) {
      expect(JSON.stringify((await call('GET', agent, undefined, { 'X-Agent-Token': AGENT_TOKEN })).body)).not.toMatch(/draft|Kept as-is|approve/i);
    }
  });
});

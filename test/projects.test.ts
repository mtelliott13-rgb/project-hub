import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { listActiveProjects, openDb, syncProjects } from '../src/server/db/index.ts';
import { parseProjects } from '../src/server/projects.ts';
import { HUB, testDeps } from './helpers.ts';

const SPEC_EXAMPLE = `
projects:
  - slug: acme-site
    name: Acme website
    repos: [~/code/acme-site]
    folders: [~/Documents/Acme]
    github: [yourname/acme-site]
    claude_project: https://claude.ai/project/0f6c1c1e-0000-4000-8000-000000000000
    keywords: [acme, landing page]
`;

describe('parseProjects', () => {
  it('parses the SPEC.md example and expands ~', () => {
    const [p] = parseProjects(SPEC_EXAMPLE);
    expect(p.slug).toBe('acme-site');
    expect(p.repos).toEqual([path.join(os.homedir(), 'code/acme-site')]);
    expect(p.github).toEqual(['yourname/acme-site']);
    expect(p.keywords).toEqual(['acme', 'landing page']);
  });

  it('defaults the optional lists', () => {
    const [p] = parseProjects('projects:\n  - slug: solo\n    name: Solo\n');
    expect(p).toMatchObject({ repos: [], folders: [], github: [], keywords: [], sessions: [] });
    expect(p.claude_project).toBeUndefined();
  });

  it('treats an empty file as no projects', () => {
    expect(parseProjects('')).toEqual([]);
  });

  it('rejects a bad slug, a bad github entry and duplicate slugs', () => {
    expect(() => parseProjects('projects:\n  - slug: Bad Slug\n    name: X\n')).toThrow(/kebab-case/);
    expect(() => parseProjects('projects:\n  - slug: x\n    name: X\n    github: [nope]\n')).toThrow(/owner\/repo/);
    expect(() =>
      parseProjects('projects:\n  - slug: x\n    name: X\n  - slug: x\n    name: Y\n'),
    ).toThrow(/duplicate slug "x"/);
  });
});

describe('database sync and API', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
    dirs.push(dir);
    return openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  }

  it('upserts projects and archives ones removed from the YAML', () => {
    const db = freshDb();
    syncProjects(db, parseProjects('projects:\n  - slug: a\n    name: A\n  - slug: b\n    name: B\n'));
    expect(listActiveProjects(db).map((p) => p.slug)).toEqual(['a', 'b']);

    syncProjects(db, parseProjects('projects:\n  - slug: b\n    name: B renamed\n'));
    expect(listActiveProjects(db).map((p) => [p.slug, p.name])).toEqual([['b', 'B renamed']]);
  });

  it('serves one entry per project from /api/projects', async () => {
    const db = freshDb();
    syncProjects(db, parseProjects(SPEC_EXAMPLE));
    const app = createApp(testDeps(db).deps);
    const res = await app.request(`${HUB}/api/projects`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ slug: 'acme-site', name: 'Acme website' });
  });
});

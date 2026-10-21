// Resume and the session rows only offer sessions Claude Code can reopen: ones
// the Agent SDK lists (so a conversation was saved) whose folder still exists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { listAllProjects, openDb } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import { applyHookEvent, resumeProblem, syncFromSdk } from '../src/server/sessions.ts';
import { latestReopenable, listed } from '../web/src/resume.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const SAVED = '0b5c6a0e-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const GHOST = '8cafbf2b-0fd9-4519-b857-95ef44e0f68b';
const GONE = '9409b115-0000-4000-8000-000000000000';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
  dirs.push(dir);
  const repo = path.join(dir, 'hub');
  fs.mkdirSync(repo);
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db);
  fs.writeFileSync(t.projectsFile, `projects:\n  - slug: hub\n    name: Hub\n    repos: [${repo}]\n    folders: [${path.join(dir, 'gone')}]\n`);
  t.store.reload();
  const projects = listAllProjects(db);
  const info = (id: string, cwd: string, minutesAgo: number) =>
    ({ sessionId: id, cwd, lastModified: Date.now() - minutesAgo * 60_000, summary: 'Saved work' }) as SDKSessionInfo;

  // An older session with a saved conversation, one whose folder was deleted,
  // then the newest: a session the hooks reported but that never saved a
  // conversation (the bug: Resume picked this one).
  syncFromSdk(db, [info(SAVED, repo, 60), info(GONE, path.join(dir, 'gone'), 30)], projects, { complete: true });
  applyHookEvent(db, { session_id: GHOST, hook_event_name: 'SessionStart', cwd: repo, transcript_path: `${repo}/never-written.jsonl` }, projects);
  applyHookEvent(db, { session_id: GHOST, hook_event_name: 'SessionEnd', cwd: repo, reason: 'other' }, projects);
  const row = (id: string) => db.select().from(sessions).all().find((s) => s.id === id)!;
  return { db, t, repo, dir, projects, info, row, app: createApp(t.deps) };
}

describe('which sessions can be reopened', () => {
  it('marks only sessions the SDK lists as resumable', () => {
    const { row } = setup();
    expect(row(SAVED).resumable).toBe(true);
    expect(row(GONE).resumable).toBe(true);
    expect(row(GHOST).resumable).toBe(false);
  });

  it('un-marks a session that drops out of a complete SDK listing, but not after a single lookup', () => {
    const { db, row, repo, info, projects } = setup();
    syncFromSdk(db, [info(GONE, repo, 1)], projects); // one session's lookup: says nothing about others
    expect(row(SAVED).resumable).toBe(true);
    syncFromSdk(db, [info(GONE, repo, 1)], projects, { complete: true });
    expect(row(SAVED).resumable).toBe(false);
  });

  it('a hook event never makes a session resumable, and never un-marks one', () => {
    const { db, row, repo, projects } = setup();
    applyHookEvent(db, { session_id: SAVED, hook_event_name: 'Stop', cwd: repo }, projects);
    expect(row(SAVED).resumable).toBe(true);
  });

  it('explains why a session cannot be reopened', () => {
    expect(resumeProblem({ resumable: false, cwd: '/x' }, () => true)).toMatch(/didn't save a conversation/);
    expect(resumeProblem({ resumable: true, cwd: '/x' }, () => false)).toMatch(/folder no longer exists/);
    expect(resumeProblem({ resumable: true, cwd: '/x' }, () => true)).toBeNull();
  });

  it('the API says which sessions can be reopened, newest first', async () => {
    const { app } = setup();
    const [project] = await (await app.request(`${HUB}/api/projects`, { headers: PAGE_GET })).json();
    expect(project.sessions.map((s: { id: string; resumeProblem: string | null }) => [s.id, s.resumeProblem === null])).toEqual([
      [GHOST, false],
      [GONE, false],
      [SAVED, true],
    ]);
  });

  it('Resume on the page skips the ghost and the deleted-folder sessions', async () => {
    const { app } = setup();
    type Row = { id: string; state: string; resumeProblem: string | null };
    const [project]: { sessions: Row[] }[] = await (await app.request(`${HUB}/api/projects`, { headers: PAGE_GET })).json();
    expect(latestReopenable(project.sessions)).toMatchObject({ id: SAVED });
    expect(listed(project.sessions).map((s) => s.id)).toEqual([SAVED]);
    // A session that's running but hasn't saved anything yet is still listed, without buttons.
    const running = { id: 'r', state: 'running', resumeProblem: 'not saved' };
    expect(listed([running])).toEqual([running]);
    expect(latestReopenable([running])).toBeUndefined();
  });

  it('the launcher refuses the ghost and the deleted-folder sessions, and resumes the saved one', async () => {
    const { app, t } = setup();
    const page = { Origin: HUB, 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
    const launch = (sessionId: string, kind = 'session') =>
      app.request(`${HUB}/api/launch`, { method: 'POST', headers: page, body: JSON.stringify({ kind, sessionId }) });
    for (const kind of ['session', 'desktop']) {
      const ghost = await launch(GHOST, kind);
      expect(ghost.status).toBe(409);
      expect((await ghost.json()).error).toMatch(/didn't save a conversation/);
      expect((await launch(GONE, kind)).status).toBe(409);
    }
    expect(t.launched).toEqual([]);
    expect((await launch(SAVED)).status).toBe(200);
    expect(t.launched).toMatchObject([{ argv: ['claude', '--resume', SAVED] }]);
  });
});

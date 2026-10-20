import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { listActiveProjects, openDb, syncProjects } from '../src/server/db/index.ts';
import { sessions } from '../src/server/db/schema.ts';
import {
  formatSettings,
  HUB_HOOK_COMMAND,
  mergeHubHooks,
  removeHubHooks,
} from '../src/server/hook-settings.ts';
import { matchProject, worktreeParent } from '../src/server/matching.ts';
import { reconcileRunning, syncFromSdk, titleFromInfo } from '../src/server/sessions.ts';
import { HUB, testDeps } from './helpers.ts';

describe('matchProject', () => {
  const projects = [
    { slug: 'outer', repos: ['/u/code'], folders: [] },
    { slug: 'inner', repos: ['/u/code/app'], folders: [] },
    { slug: 'docs', repos: [], folders: ['/u/Documents/App'] },
  ];

  it('files a pinned session by id, whatever its folder', () => {
    const withPin = [...projects, { slug: 'pinned', repos: [], folders: [], pinnedSessions: ['s-home'] }];
    expect(matchProject('/u', withPin, 's-home')).toBe('pinned');
    expect(matchProject('/u/code/app', withPin, 's-home')).toBe('pinned');
    expect(matchProject('/u', withPin, 'other')).toBeNull();
    expect(matchProject('/u/code/app', withPin)).toBe('inner');
  });

  it('picks the longest path prefix', () => {
    expect(matchProject('/u/code/app/src', projects)).toBe('inner');
    expect(matchProject('/u/code/other', projects)).toBe('outer');
    expect(matchProject('/u/Documents/App', projects)).toBe('docs');
  });

  it('does not match on a shared name prefix', () => {
    expect(matchProject('/u/code/application', projects)).toBe('outer');
    expect(matchProject('/u/codebase', projects)).toBeNull();
  });

  it('treats .claude/worktrees/* as its parent repo', () => {
    expect(worktreeParent('/u/code/app/.claude/worktrees/fix-1/src')).toBe('/u/code/app');
    expect(matchProject('/u/code/app/.claude/worktrees/fix-1', projects)).toBe('inner');
  });
});

describe('hook settings', () => {
  const existing = {
    theme: 'dark',
    permissions: { defaultMode: 'default' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say "[done] https://example.com/a?b=[1]"' }] }],
    },
  };

  it('adds the three hub hooks, keeps everything else, and is idempotent', () => {
    const merged = mergeHubHooks(existing, 365);
    expect(merged.theme).toBe('dark');
    expect(merged.cleanupPeriodDays).toBe(365);
    expect(merged.hooks!.Stop).toHaveLength(2);
    expect(merged.hooks!.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(merged.hooks!.Stop[1].hooks[0]).toEqual({ type: 'command', command: HUB_HOOK_COMMAND, async: true });
    expect(merged.hooks!.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: HUB_HOOK_COMMAND });
    expect(mergeHubHooks(merged, 365)).toEqual(merged);
  });

  it('never lowers a longer cleanup period', () => {
    expect(mergeHubHooks({ cleanupPeriodDays: 500 }, 365).cleanupPeriodDays).toBe(500);
  });

  it('round-trips existing command strings with brackets and URLs unchanged', () => {
    const merged = mergeHubHooks(existing, 365);
    expect(JSON.parse(formatSettings(merged))).toStrictEqual(merged);
  });

  it('uninstall removes only the hub hooks', () => {
    expect(removeHubHooks(mergeHubHooks(existing, 365))).toEqual({ ...existing, cleanupPeriodDays: 365 });
    expect(removeHubHooks(mergeHubHooks({ theme: 'dark' }, 30))).toEqual({ theme: 'dark', cleanupPeriodDays: 30 });
  });
});

describe('titleFromInfo', () => {
  const info = (o: Partial<SDKSessionInfo>): SDKSessionInfo => ({ sessionId: 's', summary: '', lastModified: 0, ...o });

  it('prefers a custom title, then a generated summary', () => {
    expect(titleFromInfo(info({ customTitle: 'Mine', summary: 'Auto' }))).toBe('Mine');
    expect(titleFromInfo(info({ summary: 'Fix login bug', firstPrompt: 'the login form 500s' }))).toBe('Fix login bug');
  });

  it('never returns the first prompt, even truncated', () => {
    expect(titleFromInfo(info({ summary: 'please fix the login', firstPrompt: 'please fix the login' }))).toBeNull();
    expect(titleFromInfo(info({ summary: 'please fix the…', firstPrompt: 'please fix the login form' }))).toBeNull();
  });
});

describe('sessions in the database', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
    dirs.push(dir);
    const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
    syncProjects(db, [
      { slug: 'app', name: 'App', repos: ['/u/app'], folders: [], github: [], keywords: [], sessions: [] },
    ]);
    const app = createApp(testDeps(db).deps);
    const post = (body: unknown, token = 't0ken') =>
      app.request(`${HUB}/hooks/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token },
        body: JSON.stringify(body),
      });
    const row = (id: string) => db.select().from(sessions).all().find((s) => s.id === id);
    return { db, app, post, row };
  }

  const event = (name: string, extra = {}) => ({
    session_id: 's1',
    hook_event_name: name,
    cwd: '/u/app/src',
    transcript_path: '/t/s1.jsonl',
    prompt: 'secret prompt text',
    last_assistant_message: 'secret reply',
    ...extra,
  });

  it('rejects a missing or wrong token', async () => {
    const { post, row } = setup();
    expect((await post(event('SessionStart'), 'nope')).status).toBe(401);
    expect(row('s1')).toBeUndefined();
  });

  it('records start and end, matched to the project, without prompt text', async () => {
    const { post, row, app } = setup();
    expect((await post(event('SessionStart', { model: 'claude-opus-5-5' }))).status).toBe(204);
    expect(row('s1')).toMatchObject({ state: 'running', projectSlug: 'app', model: 'claude-opus-5-5' });
    expect(JSON.stringify(row('s1'))).not.toMatch(/secret/);

    await post(event('SessionEnd', { reason: 'prompt_input_exit' }));
    expect(row('s1')).toMatchObject({ state: 'ended', endReason: 'prompt_input_exit', model: 'claude-opus-5-5' });

    const [project] = await (await app.request(`${HUB}/api/projects`)).json();
    expect(project.sessions.map((s: { id: string }) => s.id)).toEqual(['s1']);
  });

  it('backfills from the SDK without overwriting hook state', async () => {
    const { db, post, row } = setup();
    await post(event('SessionStart'));
    syncFromSdk(
      db,
      [
        { sessionId: 's1', summary: 'Title', lastModified: 1, cwd: '/u/app' },
        { sessionId: 'old', summary: 'Old one', lastModified: 1_700_000_000_000, cwd: '/u/app', gitBranch: 'main' },
      ],
      listActiveProjects(db),
    );
    expect(row('s1')).toMatchObject({ state: 'running', title: 'Title' });
    expect(row('old')).toMatchObject({ state: 'ended', title: 'Old one', gitBranch: 'main', projectSlug: 'app' });
  });

  it('marks agents running and ends them once they leave the list', () => {
    const { db, row } = setup();
    const projects = listActiveProjects(db);
    reconcileRunning(db, [{ sessionId: 'bg', cwd: '/u/app', kind: 'interactive' }], projects);
    expect(row('bg')).toMatchObject({ state: 'running', kind: 'interactive' });
    reconcileRunning(db, [], projects);
    expect(row('bg')).toMatchObject({ state: 'ended', endReason: 'exited' });
  });
});

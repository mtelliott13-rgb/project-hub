// `pnpm sample`'s made-up activity (scripts/sample-seed.ts): the home page should
// show live and idle sessions, reopenable sessions, chats, an uncommitted repo
// and all three tiers. Runs on a temp copy of sample-data/, never the real one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { openDb, syncProjects } from '../src/server/db/index.ts';
import { chats, sessions } from '../src/server/db/schema.ts';
import { parseProjects } from '../src/server/projects.ts';
import { STALE_DAYS } from '../src/server/activity.ts';
import { isIdle } from '../web/src/colors.ts';
import { SAMPLE_REPO, buildSampleRepo, seedActivity, setFileTimes } from '../scripts/sample-seed.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

it('seeds live, idle and reopenable sessions, chats, an uncommitted repo and a quiet project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-sample-'));
  dirs.push(dir);
  const src = path.resolve(import.meta.dirname, '../sample-data');
  fs.cpSync(path.join(src, 'workspace'), path.join(dir, 'workspace'), { recursive: true });
  const yaml = fs.readFileSync(path.join(src, 'projects.template.yaml'), 'utf8').replaceAll('{{SAMPLE}}', dir);
  const now = Date.now();

  buildSampleRepo(path.join(dir, SAMPLE_REPO), now);
  setFileTimes(dir, now);
  const db = openDb(':memory:', MIGRATIONS_DIR);
  syncProjects(db, parseProjects(yaml));
  seedActivity(db, dir, now);
  seedActivity(db, dir, now); // re-runs replace, not duplicate

  const all = db.select().from(sessions).all().map((s) => ({ ...s, lastActiveAt: s.lastActiveAt.toISOString() }));
  const running = all.filter((s) => s.state === 'running');
  expect(running).toHaveLength(3);
  expect(new Set(running.map((s) => s.projectSlug)).size).toBe(2);
  expect(running.filter((s) => isIdle(s, now))).toHaveLength(1);
  expect(running.some((s) => now - Date.parse(s.lastActiveAt) < 3_600_000)).toBe(true);
  expect(all.filter((s) => s.state === 'ended' && s.resumable).length).toBeGreaterThanOrEqual(3);
  expect(all.every((s) => fs.existsSync(s.cwd))).toBe(true);
  expect(db.select().from(chats).all().length).toBeGreaterThanOrEqual(3);

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: path.join(dir, SAMPLE_REPO), encoding: 'utf8' });
  expect(status.trim().split('\n').length).toBeGreaterThan(0);
  const author = execFileSync('git', ['log', '--format=%an <%ae>'], { cwd: path.join(dir, SAMPLE_REPO), encoding: 'utf8' });
  expect(new Set(author.trim().split('\n'))).toEqual(new Set(['Sample Author <sample@example.com>']));

  // Land Cover is quiet: its newest file and session are older than the stale cutoff.
  const newest = Math.max(...fs.readdirSync(path.join(dir, 'workspace/land-cover')).map((f) => fs.statSync(path.join(dir, 'workspace/land-cover', f)).mtimeMs));
  expect(now - newest).toBeGreaterThan(STALE_DAYS * 86_400_000);
  expect(all.filter((s) => s.projectSlug === 'land-cover').every((s) => now - Date.parse(s.lastActiveAt) > STALE_DAYS * 86_400_000)).toBe(true);
});

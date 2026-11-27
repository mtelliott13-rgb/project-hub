// Made-up activity for `pnpm sample`, so the home page shows the hub in action:
// running sessions (one live, one idle), reopenable ended sessions, recent
// chats, a repo with uncommitted changes and one quiet project. Every time is
// relative to `now`, so the sample never goes stale.
//
// It writes only inside sample-data/: rows in its hub.db, a throwaway git repo
// in sample-data/repos/ (gitignored, rebuilt each run) and file mtimes in
// sample-data/workspace/. "Reopenable" is just the database's `resumable` flag,
// so nothing is written to ~/.claude; Resume on a sample session opens Terminal
// and Claude Code reports that it has no such conversation.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { like } from 'drizzle-orm';
import type { Db } from '../src/server/db/index.ts';
import { calendarEvents, chats, sessions, tasks } from '../src/server/db/schema.ts';
import { addDays, dateOnly, rfc3339, startOfDay } from '../src/server/calendar.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Sample ids all start with this, so a re-run replaces exactly these rows. */
const ID_PREFIX = 'aaaaaaaa-0000-4000-8000-';
const id = (n: number) => `${ID_PREFIX}${String(n).padStart(12, '0')}`;

export const SAMPLE_REPO = 'repos/market-data-pipeline';

type SampleSession = {
  n: number;
  slug: string;
  dir: string; // relative to sample-data/
  title: string;
  state: 'running' | 'ended';
  resumable: boolean;
  started: number; // ms before now
  lastActive: number; // ms before now
};

const SESSIONS: SampleSession[] = [
  // Market Data Pipeline: one live, one running but idle for days, one to reopen.
  { n: 1, slug: 'market-data-pipeline', dir: SAMPLE_REPO, title: 'Backfill missing 5-minute bars', state: 'running', resumable: true, started: 50 * MIN, lastActive: 3 * MIN },
  { n: 2, slug: 'market-data-pipeline', dir: SAMPLE_REPO, title: 'Tune paper-trading risk limits', state: 'running', resumable: true, started: 4 * DAY, lastActive: 3 * DAY + 2 * HOUR },
  { n: 3, slug: 'market-data-pipeline', dir: SAMPLE_REPO, title: 'Add retries to the quote fetcher', state: 'ended', resumable: true, started: 26 * HOUR, lastActive: 25 * HOUR },
  // Project Hub: one live, one to reopen.
  { n: 4, slug: 'project-hub', dir: 'workspace/project-hub', title: 'Polish the project map hover card', state: 'running', resumable: true, started: 90 * MIN, lastActive: 18 * MIN },
  { n: 5, slug: 'project-hub', dir: 'workspace/project-hub', title: 'Fix the CI badge colours', state: 'ended', resumable: true, started: 6 * HOUR, lastActive: 5 * HOUR },
  // Career HQ: recent but nothing running.
  { n: 6, slug: 'career-hq', dir: 'workspace/career-hq', title: 'Tidy the job feed filters', state: 'ended', resumable: true, started: 28 * HOUR, lastActive: 27 * HOUR },
  { n: 7, slug: 'career-hq', dir: 'workspace/career-hq', title: 'Check fill sheet character limits', state: 'ended', resumable: true, started: 3 * DAY + HOUR, lastActive: 3 * DAY },
  // Land Cover: last touched weeks ago, so it's quiet.
  { n: 8, slug: 'land-cover', dir: 'workspace/land-cover', title: 'Accuracy assessment for the 2019 map', state: 'ended', resumable: true, started: 26 * DAY + HOUR, lastActive: 26 * DAY },
];

const CHATS = [
  { n: 101, slug: 'career-hq', title: 'Interview prep: questions to ask', lastActive: 2 * HOUR },
  { n: 102, slug: 'market-data-pipeline', title: 'Position sizing for paper trades', lastActive: 7 * HOUR },
  { n: 103, slug: 'project-hub', title: 'Project map layout ideas', lastActive: 30 * HOUR },
  { n: 104, slug: 'career-hq', title: 'Cover letter tone check', lastActive: 2 * DAY },
  { n: 105, slug: 'land-cover', title: 'NDVI thresholds for change detection', lastActive: 30 * DAY },
];

/** Replaces the sample sessions and chats. Projects must already be synced (foreign keys). */
export function seedActivity(db: Db, sampleDir: string, now = Date.now()) {
  const at = (ago: number) => new Date(now - ago);
  db.transaction((tx) => {
    tx.delete(sessions).where(like(sessions.id, `${ID_PREFIX}%`)).run();
    tx.delete(chats).where(like(chats.id, `${ID_PREFIX}%`)).run();
    for (const s of SESSIONS) {
      tx.insert(sessions)
        .values({
          id: id(s.n),
          projectSlug: s.slug,
          cwd: path.join(sampleDir, s.dir),
          title: s.title,
          gitBranch: s.dir === SAMPLE_REPO ? 'main' : null,
          kind: 'interactive',
          resumable: s.resumable,
          state: s.state,
          endReason: s.state === 'ended' ? 'prompt_input_exit' : null,
          startedAt: at(s.started),
          lastActiveAt: at(s.lastActive),
          endedAt: s.state === 'ended' ? at(s.lastActive) : null,
        })
        .run();
    }
    for (const c of CHATS) {
      tx.insert(chats)
        .values({ id: id(c.n), title: c.title, projectSlug: c.slug, filedBy: 'manual', source: 'extension', createdAt: at(c.lastActive + DAY), lastActiveAt: at(c.lastActive) })
        .run();
    }
  });
}

/** How long ago each workspace's files were last changed: the newest file, then one step older per file. */
const FILE_AGES: Record<string, { newest: number; step: number }> = {
  'workspace/market-data-pipeline': { newest: 40 * MIN, step: 50 * MIN },
  'workspace/project-hub': { newest: 25 * MIN, step: 2 * HOUR },
  'workspace/career-hq': { newest: 26 * HOUR, step: 5 * HOUR },
  'workspace/land-cover': { newest: 24 * DAY, step: 3 * DAY },
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/** Sets workspace file mtimes so recent files, the timeline and "quiet" read the same on every run. */
export function setFileTimes(sampleDir: string, now = Date.now()) {
  for (const [rel, { newest, step }] of Object.entries(FILE_AGES)) {
    const dir = path.join(sampleDir, rel);
    if (!fs.existsSync(dir)) continue;
    walk(dir)
      .sort()
      .forEach((file, i) => {
        const t = new Date(now - newest - i * step);
        fs.utimesSync(file, t, t);
      });
  }
}

// The sample repo's history: made-up files and commits, oldest first.
const COMMITS: { ago: number; message: string; files: Record<string, string> }[] = [
  {
    ago: 6 * DAY,
    message: 'Start the market data collector',
    files: {
      'README.md': '# Market Data Pipeline (sample)\n\nMade-up sample repo for `pnpm sample`. Collects delayed quotes and runs simulated trades.\n',
      'collector.py': 'def fetch_quotes(symbols):\n    """Fetch delayed quotes for the given symbols."""\n    return {s: None for s in symbols}\n',
    },
  },
  {
    ago: 3 * DAY + 5 * HOUR,
    message: 'Add a paper-trading ledger',
    files: { 'ledger.py': 'class Ledger:\n    def __init__(self):\n        self.trades = []\n\n    def record(self, trade):\n        self.trades.append(trade)\n' },
  },
  {
    ago: 25 * HOUR,
    message: 'Retry quote fetches with backoff',
    files: { 'collector.py': 'import time\n\n\ndef fetch_quotes(symbols, retries=3):\n    """Fetch delayed quotes, retrying with backoff."""\n    for attempt in range(retries):\n        try:\n            return {s: None for s in symbols}\n        except OSError:\n            time.sleep(2**attempt)\n' },
  },
  {
    ago: 2 * HOUR,
    message: 'Store 5-minute bars in SQLite',
    files: { 'bars.py': 'BAR_MINUTES = 5\n\n\ndef bucket(ts):\n    return ts - ts % (BAR_MINUTES * 60)\n' },
  },
];

// Uncommitted work in progress (what the live session is "doing").
const WORK_IN_PROGRESS: Record<string, string> = {
  'bars.py': 'BAR_MINUTES = 5\n\n\ndef bucket(ts):\n    return ts - ts % (BAR_MINUTES * 60)\n\n\ndef missing_bars(have, start, end):\n    step = BAR_MINUTES * 60\n    return [t for t in range(bucket(start), end, step) if t not in have]\n',
  'backfill.py': 'from bars import missing_bars\n\n\ndef backfill(have, start, end):\n    return missing_bars(have, start, end)\n',
  'ledger.py': 'class Ledger:\n    def __init__(self, max_position=100):\n        self.trades = []\n        self.max_position = max_position\n\n    def record(self, trade):\n        self.trades.append(trade)\n',
};

/** Rebuilds the sample git repo: a short history with relative dates, then uncommitted changes. */
export function buildSampleRepo(dir: string, now = Date.now()) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Ignore this Mac's git config (name, email, signing, hooks), so nothing personal lands in the sample.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Sample Author',
    GIT_AUTHOR_EMAIL: 'sample@example.com',
    GIT_COMMITTER_NAME: 'Sample Author',
    GIT_COMMITTER_EMAIL: 'sample@example.com',
  };
  const git = (args: string[], extra: Record<string, string> = {}) => execFileSync('git', args, { cwd: dir, env: { ...env, ...extra }, stdio: 'pipe' });
  const write = (files: Record<string, string>, t: Date) => {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      fs.utimesSync(file, t, t);
    }
  };
  git(['init', '-q', '-b', 'main']);
  for (const c of COMMITS) {
    const t = new Date(now - c.ago);
    write(c.files, t);
    git(['add', '-A']);
    git(['commit', '-q', '-m', c.message], { GIT_AUTHOR_DATE: t.toISOString(), GIT_COMMITTER_DATE: t.toISOString() });
  }
  write(WORK_IN_PROGRESS, new Date(now - 6 * MIN));
}

// Today page: made-up calendar events (today and the next week) and tasks, so
// `pnpm sample` shows a full Today page with no Google connection. Events sit
// at fixed local times today, so the "now" line lands among them.
type SampleEvent = { day: number; title: string; at?: [number, number]; minutes?: number; allDay?: boolean; days?: number; slug?: string; recurring?: boolean };
const EVENTS: SampleEvent[] = [
  { day: 0, title: 'Morning planning', at: [9, 0], minutes: 15, recurring: true },
  { day: 0, title: 'Code review: quote fetcher retries', at: [11, 0], minutes: 30, slug: 'market-data-pipeline' },
  { day: 0, title: 'Lunch with Sam', at: [12, 30], minutes: 60 },
  { day: 0, title: 'Mock interview practice', at: [15, 0], minutes: 45, slug: 'career-hq' },
  { day: 0, title: 'Gym', at: [18, 0], minutes: 60, recurring: true },
  { day: 0, title: 'Library books due', allDay: true },
  { day: 1, title: 'Brokerage call: paper account limits', at: [10, 0], minutes: 30, slug: 'market-data-pipeline' },
  { day: 1, title: 'Morning planning', at: [9, 0], minutes: 15, recurring: true },
  { day: 2, title: 'Land cover lab report due', allDay: true, slug: 'land-cover' },
  { day: 2, title: 'Office hours', at: [14, 0], minutes: 60, slug: 'land-cover' },
  { day: 3, title: 'Coffee chat: data team at Example Energy', at: [16, 0], minutes: 30, slug: 'career-hq' },
  { day: 4, title: 'Release the project map polish', at: [11, 0], minutes: 30, slug: 'project-hub' },
  { day: 5, title: 'Data conference', allDay: true, days: 2 },
  { day: 7, title: 'Morning planning', at: [9, 0], minutes: 15, recurring: true },
];
const TASKS: { title: string; slug?: string; done?: number }[] = [
  { title: 'Renew the domain for the portfolio site' },
  { title: 'Write the backfill runbook', slug: 'market-data-pipeline' },
  { title: 'Ask Prof. Lee about the validation dataset', slug: 'land-cover' },
  { title: 'Update the resume skills section', slug: 'career-hq' },
  { title: 'Order printer ink', done: 2 * HOUR },
];

export function seedToday(db: Db, now = Date.now()) {
  const today = startOfDay(new Date(now));
  db.transaction((tx) => {
    // The sample database is throwaway: start each run with only these.
    tx.delete(calendarEvents).run();
    tx.delete(tasks).run();
    EVENTS.forEach((e, i) => {
      const day = addDays(today, e.day);
      const startsAt = e.allDay ? day : new Date(day.getFullYear(), day.getMonth(), day.getDate(), e.at![0], e.at![1]);
      const endsAt = e.allDay ? addDays(day, e.days ?? 1) : new Date(startsAt.getTime() + (e.minutes ?? 30) * MIN);
      tx.insert(calendarEvents)
        .values({
          id: `sample${String(i).padStart(4, '0')}`,
          title: e.title,
          allDay: !!e.allDay,
          start: e.allDay ? dateOnly(startsAt) : rfc3339(startsAt),
          end: e.allDay ? dateOnly(endsAt) : rfc3339(endsAt),
          startsAt,
          endsAt,
          // No link: sample events don't exist in Google Calendar.
          htmlLink: null,
          projectSlug: e.slug ?? null,
          recurring: !!e.recurring,
          createdByHub: !!e.slug,
          syncedAt: new Date(now),
        })
        .run();
    });
    TASKS.forEach((t, i) => {
      tx.insert(tasks)
        .values({ title: t.title, projectSlug: t.slug ?? null, createdAt: new Date(now - (TASKS.length - i) * DAY), completedAt: t.done ? new Date(Math.max(today.getTime() + MIN, now - t.done)) : null })
        .run();
    });
  });
}

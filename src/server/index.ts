import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { listAllSessions, runningAgents, sessionInfo } from './claude-code.ts';
import {
  BACKUP_DIR,
  extensionId,
  CLAUDE_DESKTOP_APP,
  DB_FILE,
  HOST,
  HUB_DIR,
  HUB_ORIGINS,
  IDEAS_FILE,
  LAUNCH_DIR,
  MIGRATIONS_DIR,
  PORT,
  PROJECT_DOCS_DIR,
  PROJECTS_FILE,
  SKIP_CLAUDE,
  TOKEN_FILE,
  UI_TOKEN_FILE,
  AGENT_TOKEN_FILE,
  WEB_DIST_DIR,
  UV_BIN,
} from './config.ts';
import { listAllProjects, openDb } from './db/index.ts';
import { generateCommand } from './doc-routes.ts';
import { projectDocs } from './docs.ts';
import { ChangeFeed } from './events.ts';
import { monetizeJobs, runMonetize } from './monetize.ts';
import { macProbe } from './collector.ts';
import { ghRunner, repoPoller, repoStatus } from './repos.ts';
import { TOOLKIT_FILE } from './toolkit.ts';
import { queueCandidates } from './applications.ts';
import { feedCandidates } from './job-feed.ts';
import { fileWatcher } from './files.ts';
import { fileInbox } from './links.ts';
import { refileChats } from './chats.ts';
import { macLauncher, type Launcher } from './launcher.ts';
import { createProjectStore, watchFile } from './project-store.ts';
import { reconcileRunning, syncFromSdk, withoutPids } from './sessions.ts';
import { ensureToken } from './token.ts';

const TITLE_REFRESH_MS = 5 * 60_000;
const REPO_POLL_MS = 3 * 60_000;
const AGENTS_POLL_MS = 15_000;

fs.mkdirSync(HUB_DIR, { recursive: true });

const db = openDb(DB_FILE, MIGRATIONS_DIR);

const token = ensureToken(TOKEN_FILE);
const uiToken = ensureToken(UI_TOKEN_FILE);
const agentToken = ensureToken(AGENT_TOKEN_FILE);
const launcher: Launcher =
  process.platform === 'darwin'
    ? macLauncher(LAUNCH_DIR)
    : async () => {
        throw new Error(`Launching is only implemented for macOS so far, not ${process.platform}.`);
      };
const feed = new ChangeFeed();

const logError = (what: string) => (err: unknown) =>
  console.error(`${new Date().toISOString()} ${what} failed:`, err instanceof Error ? err.message : err);

// Phase 5: every active project's repos, every 3 minutes and after each Stop event.
const gh = ghRunner(path.join(os.homedir(), '.local/bin/gh'));
const repos = repoPoller({
  repos: () => listAllProjects(db).filter((p) => !p.archived).flatMap((p) => p.repos),
  check: (dir) => repoStatus(dir, gh),
  onChange: () => feed.notify(),
});

// Phase 6: recently changed files in every active project's repos and folders.
const files = fileWatcher({
  roots: () =>
    [...new Map(
      listAllProjects(db)
        .filter((p) => !p.archived)
        .flatMap((p) => [...p.repos.map((dir) => ({ dir, repo: true })), ...p.folders.map((dir) => ({ dir, repo: fs.existsSync(path.join(dir, '.git')) }))])
        .filter((r) => fs.existsSync(r.dir))
        .map((r) => [r.dir, r]),
    ).values()],
  onChange: () => feed.notify('files'),
});

// projects.yaml is read now and again whenever it changes, by hand or from the page.
let lastFileError: string | null = null;
const store = createProjectStore(db, PROJECTS_FILE, path.join(BACKUP_DIR, 'projects.last.yaml'), () => {
  const error = store.error();
  if (error && error !== lastFileError) logError('Reading projects.yaml')(error);
  lastFileError = error;
  watchToolkits();
  files.sync();
  // A project's new GitHub repo or Claude Project may now match links in the Inbox.
  fileInbox(db, listAllProjects(db));
  // Keywords and claude_project links may have changed: re-file chats not filed by hand.
  refileChats(db, listAllProjects(db));
  // A repo just added to projects.yaml is checked now rather than at the next poll.
  for (const p of listAllProjects(db)) for (const dir of p.repos) if (!p.archived && !repos.get(dir)) void repos.refresh(dir);
  feed.notify();
});
// toolkit.yaml, the review queue and jobs/feed/feed.json in any project folder: edits
// outside the hub (or a new or deleted file) reach the card and page without a restart.
const toolkitWatchers = new Map<string, { close: () => void }>();
function watchToolkits() {
  const wanted = new Set(
    listAllProjects(db)
      .filter((p) => !p.archived)
      .flatMap((p) => [...p.repos, ...p.folders])
      .filter((dir) => fs.existsSync(dir))
      .flatMap((dir) => [path.join(dir, TOOLKIT_FILE), ...queueCandidates([dir]), ...feedCandidates([dir])]),
  );
  for (const [file, w] of toolkitWatchers) if (!wanted.has(file)) (w.close(), toolkitWatchers.delete(file));
  for (const file of wanted) if (!toolkitWatchers.has(file)) toolkitWatchers.set(file, watchFile(file, () => feed.notify()));
}

store.reload(); // also starts the toolkit.yaml watchers
watchFile(PROJECTS_FILE, store.reload);

// Phase 4: notes, Monetize drafts and Ideas. Claude Code may tick ideas.md, so watch it too.
const docs = projectDocs(PROJECT_DOCS_DIR);
const generatePids = new Set<number>();
watchFile(IDEAS_FILE, () => feed.notify());
const jobs = monetizeJobs(
  async (slug) => {
    const p = listAllProjects(db).find((x) => x.slug === slug);
    if (!p) throw new Error(`Unknown project ${slug}`);
    return runMonetize(generateCommand(docs, p), generatePids);
  },
  (slug, result) => {
    const id = docs.addDraft(slug, result.text, result.costUsd);
    console.log(`${new Date().toISOString()} Monetize draft ${id} saved for ${slug} (cost $${result.costUsd ?? '?'})`);
  },
  () => feed.notify(),
);

async function refreshFromSdk() {
  if (syncFromSdk(db, await listAllSessions(), listAllProjects(db), { complete: true }) > 0) feed.notify();
}

// `claude agents --json` occasionally hangs when run from the hub (see CLAUDE.md),
// so never start a second one while the last is still out.
let agentsInFlight = false;
async function refreshRunning() {
  if (agentsInFlight) return;
  agentsInFlight = true;
  try {
    reconcileRunning(db, withoutPids(await runningAgents(), generatePids), listAllProjects(db));
    feed.notify();
  } finally {
    agentsInFlight = false;
  }
}

// A session's title appears after its first turn, so look it up shortly after
// hook activity rather than waiting for the 5-minute refresh.
const pendingTitles = new Map<string, NodeJS.Timeout>();
function refreshTitleSoon(sessionId: string, cwd: string) {
  clearTimeout(pendingTitles.get(sessionId));
  pendingTitles.set(
    sessionId,
    setTimeout(() => {
      pendingTitles.delete(sessionId);
      sessionInfo(sessionId, cwd)
        .then((info) => info && syncFromSdk(db, [info], listAllProjects(db)) > 0 && feed.notify())
        .catch(logError('Title refresh'));
    }, 3_000),
  );
}

const app = createApp({
  db,
  webDir: WEB_DIST_DIR,
  token,
  feed,
  uiToken,
  origins: HUB_ORIGINS,
  launcher,
  store,
  probe: macProbe,
  docs,
  ideasFile: IDEAS_FILE,
  jobs,
  claudeDesktopInstalled: fs.existsSync(CLAUDE_DESKTOP_APP),
  onSessionActivity: refreshTitleSoon,
  repos,
  toolkitBackupDir: path.join(BACKUP_DIR, 'toolkit'),
  uvPath: UV_BIN,
  files,
  extensionId: extensionId(),
  agentToken,
});
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Project Hub on http://${HOST}:${info.port} with ${listAllProjects(db).filter((p) => !p.archived).length} project(s)`);
  if (!SKIP_CLAUDE) {
    refreshFromSdk().catch(logError('Session backfill'));
    refreshRunning().catch(logError('claude agents'));
    setInterval(() => refreshFromSdk().catch(logError('Title refresh')), TITLE_REFRESH_MS);
    setInterval(() => refreshRunning().catch(logError('claude agents')), AGENTS_POLL_MS);
  }
  repos.refreshAll().catch(logError('Repo check'));
  // A project folder created after projects.yaml named it starts being watched within a minute.
  setInterval(files.sync, 60_000);
  setInterval(() => repos.refreshAll().catch(logError('Repo check')), REPO_POLL_MS);
});

import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { listAllSessions, runningAgents, sessionInfo } from './claude-code.ts';
import {
  BACKUP_DIR,
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
  TOKEN_FILE,
  UI_TOKEN_FILE,
  WEB_DIST_DIR,
} from './config.ts';
import { listAllProjects, openDb } from './db/index.ts';
import { generateCommand } from './doc-routes.ts';
import { projectDocs } from './docs.ts';
import { ChangeFeed } from './events.ts';
import { monetizeJobs, runMonetize } from './monetize.ts';
import { macLauncher, type Launcher } from './launcher.ts';
import { createProjectStore, watchFile } from './project-store.ts';
import { reconcileRunning, syncFromSdk, withoutPids } from './sessions.ts';
import { ensureToken } from './token.ts';

const TITLE_REFRESH_MS = 5 * 60_000;
const AGENTS_POLL_MS = 15_000;

fs.mkdirSync(HUB_DIR, { recursive: true });

const db = openDb(DB_FILE, MIGRATIONS_DIR);

const token = ensureToken(TOKEN_FILE);
const uiToken = ensureToken(UI_TOKEN_FILE);
const launcher: Launcher =
  process.platform === 'darwin'
    ? macLauncher(LAUNCH_DIR)
    : async () => {
        throw new Error(`Launching is only implemented for macOS so far, not ${process.platform}.`);
      };
const feed = new ChangeFeed();

const logError = (what: string) => (err: unknown) =>
  console.error(`${new Date().toISOString()} ${what} failed:`, err instanceof Error ? err.message : err);

// projects.yaml is read now and again whenever it changes, by hand or from the page.
let lastFileError: string | null = null;
const store = createProjectStore(db, PROJECTS_FILE, path.join(BACKUP_DIR, 'projects.last.yaml'), () => {
  const error = store.error();
  if (error && error !== lastFileError) logError('Reading projects.yaml')(error);
  lastFileError = error;
  feed.notify();
});
store.reload();
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
  if (syncFromSdk(db, await listAllSessions(), listAllProjects(db)) > 0) feed.notify();
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
  docs,
  ideasFile: IDEAS_FILE,
  jobs,
  claudeDesktopInstalled: fs.existsSync(CLAUDE_DESKTOP_APP),
  onSessionActivity: refreshTitleSoon,
});
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Project Hub on http://${HOST}:${info.port} with ${listAllProjects(db).filter((p) => !p.archived).length} project(s)`);
  refreshFromSdk().catch(logError('Session backfill'));
  refreshRunning().catch(logError('claude agents'));
  setInterval(() => refreshFromSdk().catch(logError('Title refresh')), TITLE_REFRESH_MS);
  setInterval(() => refreshRunning().catch(logError('claude agents')), AGENTS_POLL_MS);
});

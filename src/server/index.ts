import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { listAllSessions, runningAgents, sessionInfo } from './claude-code.ts';
import {
  CLAUDE_DESKTOP_APP,
  DB_FILE,
  HOST,
  HUB_DIR,
  HUB_ORIGINS,
  LAUNCH_DIR,
  MIGRATIONS_DIR,
  PORT,
  PROJECTS_FILE,
  TOKEN_FILE,
  UI_TOKEN_FILE,
  WEB_DIST_DIR,
} from './config.ts';
import { listActiveProjects, openDb, syncProjects } from './db/index.ts';
import { ChangeFeed } from './events.ts';
import { macLauncher, type Launcher } from './launcher.ts';
import { loadProjects } from './projects.ts';
import { reconcileRunning, rematchSessions, syncFromSdk } from './sessions.ts';
import { ensureToken } from './token.ts';

const TITLE_REFRESH_MS = 5 * 60_000;
const AGENTS_POLL_MS = 15_000;

fs.mkdirSync(HUB_DIR, { recursive: true });

const db = openDb(DB_FILE, MIGRATIONS_DIR);
const configs = loadProjects(PROJECTS_FILE);
if (configs.length === 0) console.warn(`No projects found in ${PROJECTS_FILE}`);
syncProjects(db, configs);
rematchSessions(db, listActiveProjects(db));

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

async function refreshFromSdk() {
  if (syncFromSdk(db, await listAllSessions(), listActiveProjects(db)) > 0) feed.notify();
}

// `claude agents --json` occasionally hangs when run from the hub (see CLAUDE.md),
// so never start a second one while the last is still out.
let agentsInFlight = false;
async function refreshRunning() {
  if (agentsInFlight) return;
  agentsInFlight = true;
  try {
    reconcileRunning(db, await runningAgents(), listActiveProjects(db));
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
        .then((info) => info && syncFromSdk(db, [info], listActiveProjects(db)) > 0 && feed.notify())
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
  claudeDesktopInstalled: fs.existsSync(CLAUDE_DESKTOP_APP),
  onSessionActivity: refreshTitleSoon,
});
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Project Hub on http://${HOST}:${info.port} with ${configs.length} project(s)`);
  refreshFromSdk().catch(logError('Session backfill'));
  refreshRunning().catch(logError('claude agents'));
  setInterval(() => refreshFromSdk().catch(logError('Title refresh')), TITLE_REFRESH_MS);
  setInterval(() => refreshRunning().catch(logError('claude agents')), AGENTS_POLL_MS);
});

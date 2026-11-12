import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything the hub owns on disk lives in ~/.project-hub (see SPEC.md).
// PROJECT_HUB_DIR overrides it, which the tests use to stay out of $HOME.
export const HUB_DIR = process.env.PROJECT_HUB_DIR ?? path.join(os.homedir(), '.project-hub');
export const PROJECTS_FILE = path.join(HUB_DIR, 'projects.yaml');
export const DB_FILE = path.join(HUB_DIR, 'hub.db');
export const LOG_DIR = path.join(HUB_DIR, 'logs');
export const TOKEN_FILE = path.join(HUB_DIR, 'token');
export const HOOK_SCRIPT = path.join(HUB_DIR, 'hub-hook.sh');
export const BACKUP_DIR = path.join(HUB_DIR, 'backups');
// PROJECT_HUB_SKIP_CLAUDE=1 (set by `pnpm sample`) stops the hub reading this
// Mac's Claude Code sessions, so a sample run shows only the sample data.
export const SKIP_CLAUDE = process.env.PROJECT_HUB_SKIP_CLAUDE === '1';

// Bound to loopback only, so the hub is reachable only from this machine.
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PROJECT_HUB_PORT ?? 4747);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'drizzle');
export const WEB_DIST_DIR = path.join(REPO_ROOT, 'dist/web');

// Phase 2 launcher targets (macOS). See CLAUDE.md, "This machine".
export const TERMINAL_APP = 'Terminal';
export const EDITOR_APP = 'Visual Studio Code';
export const CLAUDE_DESKTOP_APP = '/Applications/Claude.app';
// The page's token for /api/launch, separate from the hook token.
export const UI_TOKEN_FILE = path.join(HUB_DIR, 'ui-token');
// The MCP server's read-only token for /agent/* (Phase 9), separate from both.
/** uv, which runs Career HQ's scripts (installed without admin rights in ~/.local/bin). */
export const UV_BIN = path.join(os.homedir(), '.local/bin/uv');
export const AGENT_TOKEN_FILE = path.join(HUB_DIR, 'agent-token');
// One-shot .command files for terminal launches; each deletes itself when it runs.
export const LAUNCH_DIR = path.join(HUB_DIR, 'launch');

/** Origins the hub's own page is served from. `pnpm dev` adds Vite's via PROJECT_HUB_DEV_ORIGIN. */
export const HUB_ORIGINS = [
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  ...(process.env.PROJECT_HUB_DEV_ORIGIN ? [process.env.PROJECT_HUB_DEV_ORIGIN] : []),
];

// Phase 4: per-project notes and Monetize drafts, and the Ideas list.
export const PROJECT_DOCS_DIR = path.join(HUB_DIR, 'projects');
export const IDEAS_FILE = path.join(HUB_DIR, 'ideas.md');

// Phase 7: the Chrome extension, loaded unpacked from here. Its ID comes from
// the public key in its manifest, so it is the same on every install, and the
// hub's /ext/* routes answer only requests from that ID.
export const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');
export function extensionId(manifestFile = path.join(EXTENSION_DIR, 'manifest.json')): string {
  const { key } = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { key: string };
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

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

// Bound to loopback only, so the hub is reachable only from this machine.
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PROJECT_HUB_PORT ?? 4747);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'drizzle');
export const WEB_DIST_DIR = path.join(REPO_ROOT, 'dist/web');

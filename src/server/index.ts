import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { DB_FILE, HOST, HUB_DIR, MIGRATIONS_DIR, PORT, PROJECTS_FILE, WEB_DIST_DIR } from './config.ts';
import { openDb, syncProjects } from './db/index.ts';
import { loadProjects } from './projects.ts';

fs.mkdirSync(HUB_DIR, { recursive: true });

const db = openDb(DB_FILE, MIGRATIONS_DIR);
const configs = loadProjects(PROJECTS_FILE);
if (configs.length === 0) console.warn(`No projects found in ${PROJECTS_FILE}`);
syncProjects(db, configs);

const app = createApp({ db, webDir: WEB_DIST_DIR });
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Project Hub on http://${HOST}:${info.port} with ${configs.length} project(s)`);
});

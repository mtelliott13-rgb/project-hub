// `pnpm sample`: runs the hub against sample-data/ (made-up projects, ideas,
// a toolkit checklist and a Career HQ-style review queue) on port 4748, so it
// can run beside a real hub on 4747 without touching ~/.project-hub.
//
// projects.yaml needs absolute paths, so this writes sample-data/projects.yaml
// (gitignored) from projects.template.yaml each run. The hub's database and
// tokens land in sample-data/ too, also gitignored. It never reads this Mac's
// Claude Code sessions (PROJECT_HUB_SKIP_CLAUDE=1).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = path.join(root, 'sample-data');
const template = fs.readFileSync(path.join(sample, 'projects.template.yaml'), 'utf8');
fs.writeFileSync(path.join(sample, 'projects.yaml'), template.replaceAll('{{SAMPLE}}', sample));

const port = process.env.PROJECT_HUB_PORT ?? '4748';
const child = spawn(process.execPath, [path.join(root, 'src/server/index.ts')], {
  stdio: 'inherit',
  env: { ...process.env, PROJECT_HUB_DIR: sample, PROJECT_HUB_PORT: port, PROJECT_HUB_SKIP_CLAUDE: '1' },
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));

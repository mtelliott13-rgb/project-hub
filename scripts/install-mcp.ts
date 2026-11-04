// Registers the hub's read-only MCP server (SPEC.md, Phase 9) in three places:
//   desktop  ~/Library/Application Support/Claude/claude_desktop_config.json  (mcpServers["project-hub"])
//   code     Claude Code, user scope, via `claude mcp add --scope user` (~/.claude.json)
//   allow    ~/.claude/settings.json permissions.allow: the five tools, so Claude Code doesn't ask each time
//
//   node scripts/install-mcp.ts [plan|apply|uninstall] [--only desktop,code,allow]
// plan (the default) shows each diff and writes nothing. apply and uninstall
// back each JSON file up to ~/.project-hub/backups/ first and touch only the
// hub's own entries; after writing, the file is parsed back and checked.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BACKUP_DIR } from '../src/server/config.ts';
import { MCP_NAME, mcpCommand, withAllowRules, withDesktopEntry, withoutAllowRules, withoutDesktopEntry } from '../src/server/mcp-config.ts';

const home = os.homedir();
const DESKTOP = path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
const SETTINGS = path.join(home, '.claude/settings.json');
const CLAUDE = path.join(home, '.local/bin/claude');

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--') && !a.includes(',') && !['desktop', 'code', 'allow'].includes(a)) ?? 'plan';
const onlyAt = args.indexOf('--only');
const only = new Set(onlyAt === -1 ? ['desktop', 'code', 'allow'] : args[onlyAt + 1].split(','));
if (!['plan', 'apply', 'uninstall'].includes(mode)) throw new Error(`Unknown mode "${mode}": plan, apply or uninstall`);

type Json = Record<string, unknown>;

function diff(label: string, a: string, b: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
  fs.writeFileSync(path.join(tmp, 'current'), a);
  fs.writeFileSync(path.join(tmp, 'proposed'), b);
  try {
    return execFileSync('diff', ['-u', '--label', `${label} (current)`, '--label', `${label} (proposed)`, path.join(tmp, 'current'), path.join(tmp, 'proposed')]).toString() || '(no changes)\n';
  } catch (e) {
    return (e as { stdout: Buffer }).stdout.toString();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Plans, or backs up and writes, one JSON file. */
function jsonFile(label: string, file: string, change: (j: Json) => Json, backupName: string) {
  const currentText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n';
  const current = JSON.parse(currentText) as Json; // stops here, untouched, if it isn't valid JSON
  const next = change(current);
  const nextText = JSON.stringify(next, null, 2) + '\n';
  if (!isDeepStrictEqual(JSON.parse(nextText), next)) throw new Error(`Refusing to write ${file}: it doesn't round-trip.`);
  if (isDeepStrictEqual(current, next)) return console.log(`${label}: already as wanted, nothing to do.`);
  if (mode === 'plan') return process.stdout.write(`${label}: ${file}\n${diff(label, currentText, nextText)}\n`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `${backupName}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(dest, currentText, { flag: 'wx', mode: 0o600 });
  const tmp = `${file}.project-hub-tmp`;
  fs.writeFileSync(tmp, nextText, { mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 });
  fs.renameSync(tmp, file);
  if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next)) throw new Error(`${file} didn't read back as written; restore ${dest}`);
  console.log(`${label}: wrote ${file} (backup: ${dest})`);
}

if (only.has('desktop'))
  jsonFile('desktop', DESKTOP, (j) => (mode === 'uninstall' ? withoutDesktopEntry(j) : withDesktopEntry(j, home)), 'claude_desktop_config');

if (only.has('code')) {
  let registered = false;
  try {
    execFileSync(CLAUDE, ['mcp', 'get', MCP_NAME], { stdio: 'ignore' });
    registered = true;
  } catch {}
  const { command, args: cmdArgs } = mcpCommand(home);
  const add = ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', command, ...cmdArgs];
  const remove = ['mcp', 'remove', '--scope', 'user', MCP_NAME];
  if (mode === 'plan') console.log(`code: ${registered ? 'already registered' : `would run: claude ${add.join(' ')}`}\n`);
  else if (mode === 'apply' && !registered) console.log(`code: ${execFileSync(CLAUDE, add).toString().trim()}`);
  else if (mode === 'uninstall' && registered) console.log(`code: ${execFileSync(CLAUDE, remove).toString().trim()}`);
  else console.log(`code: nothing to do`);
}

if (only.has('allow')) jsonFile('allow', SETTINGS, (j) => (mode === 'uninstall' ? withoutAllowRules(j) : withAllowRules(j)), 'claude-settings');

if (mode === 'plan') console.log('Dry run: nothing was written. Run `pnpm mcp:install` to make these changes.');
else if (only.has('desktop')) console.log('Quit and reopen the Claude desktop app to pick up the change.');

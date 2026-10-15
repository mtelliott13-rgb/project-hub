// Installs the hub's Claude Code hooks (SPEC.md, Phase 1).
//   node scripts/install-hooks.ts                 dry run: show the current file and the diff
//   node scripts/install-hooks.ts backup          copy settings.json into ~/.project-hub/backups
//   node scripts/install-hooks.ts apply           back up, then write hub-hook.sh and settings.json
//   node scripts/install-hooks.ts uninstall       back up, then remove only the hub's hooks
// --cleanup-days N sets cleanupPeriodDays (default 365; never lowers a higher value).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BACKUP_DIR, HOOK_SCRIPT, HUB_DIR, TOKEN_FILE } from '../src/server/config.ts';
import { formatSettings, HUB_HOOK_SCRIPT, mergeHubHooks, removeHubHooks, type Settings } from '../src/server/hook-settings.ts';
import { ensureToken } from '../src/server/token.ts';

const SETTINGS = path.join(os.homedir(), '.claude/settings.json');

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'plan';
const daysFlag = args.indexOf('--cleanup-days');
const cleanupDays = daysFlag === -1 ? 365 : Number(args[daysFlag + 1]);
if (!Number.isInteger(cleanupDays) || cleanupDays < 1) throw new Error('--cleanup-days needs a whole number of days');

const currentText = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}\n';
const current = JSON.parse(currentText); // Stops here, untouched, if the file isn't valid JSON.

function backup(): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `claude-settings.${stamp}.json`);
  fs.writeFileSync(dest, currentText, { flag: 'wx' });
  return dest;
}

function diff(next: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-settings-'));
  const a = path.join(tmp, 'settings.json.current');
  const b = path.join(tmp, 'settings.json.proposed');
  fs.writeFileSync(a, currentText);
  fs.writeFileSync(b, next);
  try {
    return execFileSync('diff', ['-u', a, b]).toString() || '(no changes)\n';
  } catch (e) {
    return (e as { stdout: Buffer }).stdout.toString(); // diff exits 1 when files differ
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Serializes, then parses the text back and checks it matches the intended
 * settings exactly. Throws (writing nothing) if it doesn't.
 */
function checkedText(settings: Settings): string {
  const text = formatSettings(settings);
  if (!isDeepStrictEqual(JSON.parse(text), settings)) {
    throw new Error('Refusing to write: the serialized settings do not round-trip to the merged settings.');
  }
  return text;
}

/** Write to a temp file then rename, so a crash never leaves half a settings.json. */
function writeSettings(settings: Settings) {
  const text = checkedText(settings);
  const tmp = `${SETTINGS}.project-hub-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, SETTINGS);
}

switch (mode) {
  case 'plan': {
    const next = checkedText(mergeHubHooks(current, cleanupDays));
    process.stdout.write(`Current ${SETTINGS}:\n\n${currentText}\nProposed change:\n\n${diff(next)}`);
    console.log('\nDry run: nothing was written. Run with `apply` to make the change.');
    break;
  }
  case 'backup':
    console.log(`Backed up ${SETTINGS} to ${backup()}`);
    break;
  case 'apply': {
    const merged = mergeHubHooks(current, cleanupDays);
    checkedText(merged); // Fail before touching anything, including the backup.
    console.log(`Backed up ${SETTINGS} to ${backup()}`);
    fs.mkdirSync(HUB_DIR, { recursive: true });
    ensureToken(TOKEN_FILE);
    fs.writeFileSync(HOOK_SCRIPT, HUB_HOOK_SCRIPT, { mode: 0o755 });
    fs.chmodSync(HOOK_SCRIPT, 0o755);
    writeSettings(merged);
    console.log(`Wrote ${HOOK_SCRIPT} and updated ${SETTINGS}. New Claude Code sessions will report to the hub.`);
    break;
  }
  case 'uninstall': {
    const stripped = removeHubHooks(current);
    checkedText(stripped);
    console.log(`Backed up ${SETTINGS} to ${backup()}`);
    writeSettings(stripped);
    console.log(`Removed the hub's hooks from ${SETTINGS}. cleanupPeriodDays was left as it is.`);
    break;
  }
  default:
    console.error('Usage: node scripts/install-hooks.ts [backup | apply | uninstall] [--cleanup-days N]');
    process.exit(1);
}

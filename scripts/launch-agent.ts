// Run-at-login for macOS: a per-user launchd agent. No admin password needed.
// Usage: node scripts/launch-agent.ts install | uninstall | status
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HUB_DIR, LOG_DIR, REPO_ROOT, WEB_DIST_DIR } from '../src/server/config.ts';

const LABEL = 'local.project-hub';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid!()}`;
const LOG_FILE = path.join(LOG_DIR, 'hub.log');

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist() {
  const args = [process.execPath, '--disable-warning=ExperimentalWarning', path.join(REPO_ROOT, 'src/server/index.ts')];
  // launchd starts with a bare PATH; later phases shell out to git, gh and claude.
  const pathEnv = [path.dirname(process.execPath), path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`;
}

const launchctl = (...args: string[]) => execFileSync('launchctl', args, { stdio: 'pipe' }).toString();
const isLoaded = () => {
  try {
    launchctl('print', `${DOMAIN}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
};

if (process.platform !== 'darwin') {
  console.error('Run-at-login is only implemented for macOS so far.');
  process.exit(1);
}

switch (process.argv[2]) {
  case 'install': {
    if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
      console.error('Build the UI first: pnpm build');
      process.exit(1);
    }
    fs.mkdirSync(HUB_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    if (isLoaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`);
    fs.writeFileSync(PLIST, plist());
    launchctl('bootstrap', DOMAIN, PLIST);
    console.log(`Installed ${PLIST}\nThe hub starts now and at every login. Logs: ${LOG_FILE}`);
    break;
  }
  case 'uninstall': {
    if (isLoaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`);
    fs.rmSync(PLIST, { force: true });
    console.log('Removed the launch agent. The hub will no longer start at login.');
    break;
  }
  case 'status': {
    console.log(isLoaded() ? `Loaded: ${DOMAIN}/${LABEL}` : 'Not loaded');
    break;
  }
  default:
    console.error('Usage: node scripts/launch-agent.ts install | uninstall | status');
    process.exit(1);
}

// `pnpm check:secrets`: looks for secrets and personal data before they're committed.
//
//   pnpm check:secrets          lines being added in staged files (run before every commit)
//   pnpm check:secrets --all    every tracked file (CI)
//
// Always checked: secret shapes (Google client secrets and tokens, Anthropic
// keys, Google API keys, private keys) and email addresses outside the example
// domains. On your own Mac it also checks for your git email, your home folder
// path, and, in staged lines only, the names and slugs of your real projects
// and the titles of your real calendar events and tasks. Those come from
// ~/.project-hub and git config when it runs, so the script itself holds none of them.
// Exits 1 if anything is found, printing where (never the matched value in full).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECRET_PATTERNS } from '../src/server/secrets.ts';

export type Finding = { file: string; line: number; what: string };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Domains reserved for examples (RFC 2606) and addresses that are public by design. */
const ALLOWED_EMAIL_DOMAINS = [/(^|\.)example\.(com|org|net)$/i, /\.example$/i, /\.test$/i, /\.invalid$/i, /(^|\.)users\.noreply\.github\.com$/i];
const ALLOWED_EMAILS = new Set(['git@github.com', 'noreply@anthropic.com', 'noreply@github.com']);

/** Files that can't hold anything we look for, or that hash-heavy text would confuse. */
const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|db|sqlite)$/i, /^drizzle\/meta\//];

export type Personal = {
  /** Exact strings (case-insensitive) that must not appear anywhere. */
  everywhere: string[];
  /** Phrases checked only in staged lines (real project names, event and task titles). */
  stagedOnly: string[];
};

const mask = (s: string) => (s.length <= 8 ? s.slice(0, 2) + '…' : s.slice(0, 6) + '…');

export function scanText(file: string, text: string, personal: Personal, staged: boolean, lineNumbers?: number[]): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = lineNumbers?.[i] ?? i + 1;
    for (const { name, re } of SECRET_PATTERNS) {
      for (const m of line.matchAll(new RegExp(re.source, 'g'))) out.push({ file, line: n, what: `${name} (${mask(m[0])})` });
    }
    for (const m of line.matchAll(EMAIL)) {
      const addr = m[0].toLowerCase();
      const domain = addr.split('@')[1];
      if (ALLOWED_EMAILS.has(addr) || ALLOWED_EMAIL_DOMAINS.some((d) => d.test(domain))) continue;
      out.push({ file, line: n, what: `email address outside the example domains (${mask(addr)})` });
    }
    const lower = line.toLowerCase();
    for (const p of personal.everywhere) if (p && lower.includes(p.toLowerCase())) out.push({ file, line: n, what: `personal data (${mask(p)})` });
    if (staged) {
      for (const p of personal.stagedOnly) {
        const re = new RegExp(`(^|[^a-z0-9])${p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
        if (re.test(lower)) out.push({ file, line: n, what: `looks like your real data (${mask(p)})` });
      }
    }
  });
  return out;
}

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Your own details, read now from git config, the OS and ~/.project-hub. Never written anywhere. */
export function localPersonal(hubDir = process.env.PROJECT_HUB_DIR ?? path.join(os.homedir(), '.project-hub'), sampleDir = 'sample-data'): Personal {
  const everywhere: string[] = [];
  try {
    const email = git(['config', 'user.email']).trim();
    if (email && !ALLOWED_EMAIL_DOMAINS.some((d) => d.test(email.split('@')[1] ?? ''))) everywhere.push(email);
  } catch {}
  const user = os.userInfo().username;
  if (user && user.length >= 3) everywhere.push(`/Users/${user}/`, `/home/${user}/`);
  // This Mac's time zone says roughly where you live; use an unrelated one in tests and samples.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone && zone.includes('/') && !/^(UTC|Etc\/)/.test(zone)) everywhere.push(zone);

  // Real project names and slugs, minus the ones the sample data uses on purpose.
  const sampleWords = new Set<string>();
  const tpl = path.join(sampleDir, 'projects.template.yaml');
  if (fs.existsSync(tpl)) for (const m of fs.readFileSync(tpl, 'utf8').matchAll(/^\s*-?\s*(?:slug|name):\s*(.+)$/gm)) sampleWords.add(m[1].trim().replace(/^["']|["']$/g, '').toLowerCase());
  const stagedOnly: string[] = [];
  const pf = path.join(hubDir, 'projects.yaml');
  if (fs.existsSync(pf)) {
    for (const m of fs.readFileSync(pf, 'utf8').matchAll(/^\s*-?\s*(?:slug|name):\s*(.+)$/gm)) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v.length >= 4 && !sampleWords.has(v.toLowerCase())) stagedOnly.push(v);
    }
  }
  // Real event and task titles from the hub's database, if it has them.
  const dbFile = path.join(hubDir, 'hub.db');
  if (fs.existsSync(dbFile)) {
    try {
      for (const table of ['calendar_events', 'tasks']) {
        const out = execFileSync('sqlite3', ['-readonly', dbFile, `SELECT title FROM ${table}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        for (const t of out.split('\n')) if (t.trim().length >= 6) stagedOnly.push(t.trim());
      }
    } catch {
      // No sqlite3, or the tables don't exist yet.
    }
  }
  return { everywhere, stagedOnly };
}

/** Added lines per staged file, with their line numbers in the new version. */
function stagedAdditions(): { file: string; lines: string[]; numbers: number[] }[] {
  const diff = git(['diff', '--cached', '--unified=0', '--no-color', '--diff-filter=ACMR']);
  const files: { file: string; lines: string[]; numbers: number[] }[] = [];
  let cur: (typeof files)[number] | null = null;
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const f = line.slice(4).replace(/^b\//, '');
      cur = f === '/dev/null' ? null : { file: f, lines: [], numbers: [] };
      if (cur) files.push(cur);
    } else if (line.startsWith('@@')) {
      n = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (cur && line.startsWith('+')) {
      cur.lines.push(line.slice(1));
      cur.numbers.push(n++);
    }
  }
  return files;
}

function main() {
  const all = process.argv.includes('--all');
  const personal = localPersonal();
  const findings: Finding[] = [];
  if (all) {
    for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
      if (SKIP.some((re) => re.test(file)) || !fs.existsSync(file) || fs.statSync(file).size > 4_000_000) continue;
      const buf = fs.readFileSync(file);
      if (buf.includes(0)) continue; // binary
      findings.push(...scanText(file, buf.toString('utf8'), personal, false));
    }
  } else {
    for (const { file, lines, numbers } of stagedAdditions()) {
      if (SKIP.some((re) => re.test(file))) continue;
      findings.push(...scanText(file, lines.join('\n'), personal, true, numbers));
    }
  }
  if (findings.length) {
    console.error(`check:secrets found ${findings.length} problem(s):`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.what}`);
    process.exit(1);
  }
  console.log(`check:secrets: nothing found (${all ? 'all tracked files' : 'staged changes'}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

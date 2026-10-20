// Folders for the Add/Edit project form, so paths are picked, not typed.
// Browsing stays inside the home folder and lists folder names only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from './db/index.ts';
import { sessions } from './db/schema.ts';
import { worktreeParent } from './matching.ts';

const HOME = os.homedir();

export type FolderEntry = { name: string; path: string; isRepo: boolean };

export const isRepo = (dir: string) => fs.existsSync(path.join(dir, '.git'));

const isInsideHome = (p: string, home = HOME) => p === home || p.startsWith(home + path.sep);

/** Hidden folders and ~/Library are never listed. */
function subfolders(dir: string, home = HOME): FolderEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !(dir === home && e.name === 'Library'))
    .map((e) => {
      const p = path.join(dir, e.name);
      return { name: e.name, path: p, isRepo: isRepo(p) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class FolderError extends Error {}

/** One level of the home folder tree. */
export function browse(dir?: string, home = HOME) {
  const resolved = path.resolve(dir ?? home);
  if (!isInsideHome(resolved, home)) throw new FolderError('Only folders inside your home folder can be picked');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new FolderError(`Not a folder: ${resolved}`);
  // A symlink inside ~ must not lead the browser outside it.
  if (!isInsideHome(fs.realpathSync(resolved), fs.realpathSync(home))) {
    throw new FolderError('Only folders inside your home folder can be picked');
  }
  return {
    path: resolved,
    parent: resolved === home ? null : path.dirname(resolved),
    isRepo: isRepo(resolved),
    entries: subfolders(resolved, home),
  };
}

/** Git repos near the top of ~, ~/Documents and ~/Desktop, plus every folder a session ran in. */
export function suggestions(db: Db): FolderEntry[] {
  const found = new Map<string, FolderEntry>();
  const add = (p: string) => {
    if (p !== HOME && isInsideHome(p) && fs.existsSync(p) && !found.has(p)) {
      found.set(p, { name: path.basename(p), path: p, isRepo: isRepo(p) });
    }
  };
  const scan = (dir: string, depth: number) => {
    for (const e of subfolders(dir)) {
      if (e.isRepo) add(e.path);
      else if (depth > 1) scan(e.path, depth - 1);
    }
  };
  scan(HOME, 1);
  scan(path.join(HOME, 'Documents'), 2);
  scan(path.join(HOME, 'Desktop'), 1);
  for (const { cwd } of db.selectDistinct({ cwd: sessions.cwd }).from(sessions).all()) add(worktreeParent(cwd));
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Checks paths from the form: absolute, inside ~, and (for paths the project
 * didn't already list) existing folders, git repos where `repos` asks for one.
 */
export function checkPaths(paths: string[], kind: 'repos' | 'folders', alreadyListed: string[], home = HOME) {
  for (const p of paths) {
    if (!path.isAbsolute(p) || path.resolve(p) !== p) throw new FolderError(`Not an absolute path: ${p}`);
    if (!isInsideHome(p, home)) throw new FolderError(`Only folders inside your home folder can be picked: ${p}`);
    if (alreadyListed.includes(p)) continue;
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new FolderError(`Not a folder: ${p}`);
    if (kind === 'repos' && !isRepo(p)) throw new FolderError(`Not a git repo (no .git): ${p}. Add it under Folders instead.`);
  }
}

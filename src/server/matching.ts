import path from 'node:path';

type Matchable = { slug: string; repos: string[]; folders: string[] };

/** A worktree under <repo>/.claude/worktrees/<name> belongs to <repo>. */
export function worktreeParent(cwd: string): string {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const i = cwd.indexOf(marker);
  return i === -1 ? cwd : cwd.slice(0, i);
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/**
 * Finds the project whose repo or folder is the longest path prefix of cwd,
 * so a nested project wins over the folder that contains it.
 */
export function matchProject(cwd: string, projects: Matchable[]): string | null {
  const dir = path.resolve(worktreeParent(cwd));
  let best: { slug: string; length: number } | null = null;
  for (const p of projects) {
    for (const root of [...p.repos, ...p.folders]) {
      const r = path.resolve(root);
      if (isInside(dir, r) && (!best || r.length > best.length)) best = { slug: p.slug, length: r.length };
    }
  }
  return best?.slug ?? null;
}

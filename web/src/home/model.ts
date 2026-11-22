// What the home page derives from the projects and their activity: tiers for
// the constellation and groups, the stat tiles' numbers, and the newest thing
// to pick up. Pure, so it's easy to follow; no fetching here.
import type { ProjectActivity, ProjectDto } from '../api.ts';
import { runningCounts } from '../colors.ts';
import { resumeTarget } from '../resume.ts';

/** Pinned project slugs, kept in this browser (localStorage). */
export const PINS_KEY = 'project-hub:pins';

export type Tier = 'running' | 'recent' | 'quiet';
type Activity = Record<string, ProjectActivity> | undefined;

/** Running: a session is running. Quiet: stale (14 days or more). Recent: everything else. */
export function tierOf(p: ProjectDto, activity: Activity): Tier {
  if (p.sessions.some((s) => s.state === 'running')) return 'running';
  if (activity?.[p.slug]?.stale) return 'quiet';
  return 'recent';
}

export const daysSince = (iso: string, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));

/** "2 days ago", "3 hours ago", "just now". */
export function longAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return n(Math.floor(s / 60), 'minute');
  if (s < 86400) return n(Math.floor(s / 3600), 'hour');
  return n(Math.floor(s / 86400), 'day');
}

export type HomeStats = {
  running: number;
  idle: number;
  runningProjects: number;
  perProject: { slug: string; name: string; running: number; idle: number }[];
  active: number;
  total: number;
  /** One per project, in home order: filled when active (not stale). */
  pips: { slug: string; name: string; active: boolean }[];
  uncommittedRepos: number;
  quiet: number;
  toolkitDone: number;
  toolkitTotal: number;
  toolkits: { slug: string; name: string; done: number; total: number }[];
  needs: { slug: string; name: string; why: string }[];
  needsCount: number;
};

/** The numbers behind the stat tiles and side charts, over projects that aren't archived. */
export function homeStats(projects: ProjectDto[], activity: Activity): HomeStats {
  const perProject = projects.map((p) => ({ slug: p.slug, name: p.name, ...runningCounts(p.sessions) }));
  const toolkits = projects.filter((p) => p.toolkit && !p.toolkit.error && p.toolkit.total > 0).map((p) => ({ slug: p.slug, name: p.name, done: p.toolkit!.done, total: p.toolkit!.total }));
  const needs: HomeStats['needs'] = [];
  let needsCount = 0;
  for (const p of projects) {
    const dirty = p.repoStatus.filter((r) => (r?.git?.uncommitted ?? 0) > 0);
    if (dirty.length) {
      needsCount += dirty.length;
      const n = dirty.reduce((t, r) => t + (r?.git?.uncommitted ?? 0), 0);
      needs.push({ slug: p.slug, name: p.name, why: `${n} uncommitted${dirty.length > 1 ? ` in ${dirty.length} repos` : ''}` });
    }
    const a = activity?.[p.slug];
    if (a?.stale) {
      needsCount += 1;
      needs.push({ slug: p.slug, name: p.name, why: a.last ? `quiet ${daysSince(a.last.at)}d` : 'quiet' });
    }
  }
  return {
    running: perProject.reduce((n, x) => n + x.running, 0),
    idle: perProject.reduce((n, x) => n + x.idle, 0),
    runningProjects: perProject.filter((x) => x.running > 0).length,
    perProject,
    active: projects.filter((p) => !activity?.[p.slug]?.stale).length,
    pips: projects.map((p) => ({ slug: p.slug, name: p.name, active: !activity?.[p.slug]?.stale })),
    uncommittedRepos: projects.reduce((n, p) => n + p.repoStatus.filter((r) => (r?.git?.uncommitted ?? 0) > 0).length, 0),
    quiet: projects.filter((p) => activity?.[p.slug]?.stale).length,
    total: projects.length,
    toolkitDone: toolkits.reduce((n, t) => n + t.done, 0),
    toolkitTotal: toolkits.reduce((n, t) => n + t.total, 0),
    toolkits,
    needs,
    needsCount,
  };
}

/** The newest session or chat across all projects that Resume could open (each project's resumeTarget). */
export function newestPickUp(projects: ProjectDto[]) {
  let best: { project: ProjectDto; target: NonNullable<ReturnType<typeof resumeTarget<ProjectDto['sessions'][number], ProjectDto['chats'][number]>>>; at: string } | null = null;
  for (const p of projects) {
    const target = resumeTarget(p.sessions, p.chats);
    if (!target) continue;
    const at = target.kind === 'chat' ? target.chat.lastActiveAt : target.session.lastActiveAt;
    if (!best || at > best.at) best = { project: p, target, at };
  }
  return best;
}

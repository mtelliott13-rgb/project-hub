// Status and activity (SPEC.md, Phase 8): one timeline per project built from
// what the hub already knows (sessions, chats, commits, CI, recent files and
// links), the newest thing that happened, the "stale after 14 days" rule, the
// status badges and the home page order. Facts only, no summaries.
//
// Pure functions with type-only imports, so the page can import them too.
import type { RepoStatus } from './repos.ts';

export const STALE_DAYS = 14;
const DAY = 86_400_000;
const HOUR = 3_600_000;

type When = Date | string;
const iso = (d: When) => (typeof d === 'string' ? d : d.toISOString());

export type ActivityEvent =
  | { kind: 'session'; at: string; title: string | null; state: 'running' | 'ended'; sessionId: string; reopenable: boolean }
  | { kind: 'chat'; at: string; title: string | null; chatId: string }
  | { kind: 'commit'; at: string; title: string; short: string; url: string | null }
  | { kind: 'ci'; at: string; state: 'passing' | 'failing' | 'pending' | 'none'; workflow: string; url: string }
  | { kind: 'files'; at: string; count: number; names: string[]; path: string }
  | { kind: 'link'; at: string; title: string | null; url: string };

export type ActivityInput = {
  /** Only sessions the page lists (reopenable or running); the rest never held a conversation. */
  sessions: { id: string; title: string | null; state: 'running' | 'ended'; lastActiveAt: When; endedAt: When | null; resumeProblem: string | null }[];
  chats: { id: string; title: string | null; lastActiveAt: When }[];
  repos: (RepoStatus | null)[];
  /** Recent files, newest first (names and mtimes only). */
  files: { path: string; rel: string; mtime: string }[];
  links: { url: string; title: string | null; createdAt: When }[];
};

/** Every event for one project, newest first. Files are grouped by clock hour. */
export function buildTimeline(input: ActivityInput): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const s of input.sessions)
    events.push({
      kind: 'session',
      at: iso(s.state === 'ended' && s.endedAt ? s.endedAt : s.lastActiveAt),
      title: s.title,
      state: s.state,
      sessionId: s.id,
      reopenable: s.resumeProblem === null,
    });
  for (const c of input.chats) events.push({ kind: 'chat', at: iso(c.lastActiveAt), title: c.title, chatId: c.id });
  const seen = new Set<string>();
  for (const r of input.repos) {
    if (!r) continue;
    for (const c of r.git?.commits ?? []) {
      if (seen.has(c.hash)) continue;
      seen.add(c.hash);
      events.push({ kind: 'commit', at: c.date, title: c.subject, short: c.short, url: r.github ? `https://github.com/${r.github.repo}/commit/${c.hash}` : null });
    }
    const ci = r.github?.ci;
    if (ci) events.push({ kind: 'ci', at: ci.at, state: ci.state, workflow: ci.workflow, url: ci.url });
  }
  const hours = new Map<number, ActivityInput['files']>();
  for (const f of input.files) {
    const h = Math.floor(Date.parse(f.mtime) / HOUR);
    hours.set(h, [...(hours.get(h) ?? []), f]);
  }
  for (const group of hours.values()) {
    const sorted = [...group].sort((a, b) => b.mtime.localeCompare(a.mtime));
    events.push({ kind: 'files', at: sorted[0].mtime, count: sorted.length, names: sorted.slice(0, 3).map((f) => f.rel), path: sorted[0].path });
  }
  for (const l of input.links) events.push({ kind: 'link', at: iso(l.createdAt), title: l.title, url: l.url });
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The newest thing you did. A CI result is GitHub's doing, not yours, so it never counts. */
export const lastActivity = (events: ActivityEvent[]): ActivityEvent | null => events.find((e) => e.kind !== 'ci') ?? null;

/** No activity for 14 days or more. A project with no activity at all isn't stale, just new. */
export const isStale = (last: ActivityEvent | null, now = Date.now()) => !!last && now - Date.parse(last.at) >= STALE_DAYS * DAY;

export type ProjectActivity = { last: ActivityEvent | null; stale: boolean };

/** One line describing an event, e.g. `session "Add CI to card"` or `6 files changed`. */
export function describeEvent(e: ActivityEvent): string {
  const quoted = (t: string | null, none: string) => (t ? `"${t}"` : none);
  switch (e.kind) {
    case 'session':
      return `session ${quoted(e.title, '(untitled)')}${e.state === 'running' ? ' (running)' : ''}`;
    case 'chat':
      return `chat ${quoted(e.title, '(untitled)')}`;
    case 'commit':
      return `commit ${quoted(e.title, '')}`;
    case 'ci':
      return `CI ${e.state === 'passing' ? 'passed' : e.state === 'failing' ? 'failed' : e.state === 'pending' ? 'running' : 'finished'}`;
    case 'files':
      return e.count === 1 ? `edited ${e.names[0]}` : `${e.count} files changed`;
    case 'link':
      return `link ${e.title ? `"${e.title}"` : e.url}`;
  }
}

export type BadgeId = 'running' | 'ci-failing' | 'prs' | 'uncommitted' | 'to-push' | 'stale';
export type StatusBadge = { id: BadgeId; label: string };

/** Status badges, in priority order. Counts add up across a project's repos. */
export function statusBadges(p: { sessions: { state: string }[]; repoStatus: (RepoStatus | null)[] }, stale: boolean): StatusBadge[] {
  const out: StatusBadge[] = [];
  const repos = p.repoStatus.filter((r): r is RepoStatus => !!r);
  const sum = (f: (r: RepoStatus) => number) => repos.reduce((n, r) => n + f(r), 0);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (p.sessions.some((s) => s.state === 'running')) out.push({ id: 'running', label: 'running' });
  if (repos.some((r) => r.github?.ci?.state === 'failing')) out.push({ id: 'ci-failing', label: 'CI failing' });
  const prs = sum((r) => r.github?.prs.length ?? 0);
  if (prs) out.push({ id: 'prs', label: `${plural(prs, 'PR')} waiting` });
  const uncommitted = sum((r) => r.git?.uncommitted ?? 0);
  if (uncommitted) out.push({ id: 'uncommitted', label: `${uncommitted} uncommitted` });
  const ahead = sum((r) => r.git?.ahead ?? 0);
  if (ahead) out.push({ id: 'to-push', label: `${ahead} to push` });
  if (stale) out.push({ id: 'stale', label: 'stale' });
  return out;
}

/** Home page order: projects with a running session first, then newest activity, then by name. */
export function sortProjects<P extends { name: string; sessions: { state: string }[] }>(projects: P[], activity: Record<string, ProjectActivity> | undefined, slug: (p: P) => string): P[] {
  const running = (p: P) => (p.sessions.some((s) => s.state === 'running') ? 1 : 0);
  const at = (p: P) => {
    const last = activity?.[slug(p)]?.last;
    return last ? Date.parse(last.at) : 0;
  };
  return [...projects].sort((a, b) => running(b) - running(a) || at(b) - at(a) || a.name.localeCompare(b.name));
}

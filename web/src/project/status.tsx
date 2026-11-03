// Status badges and activity icons (Phase 8), shared by the cards, the project
// page and the Cmd-K switcher. The rules live in src/server/activity.ts.
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowUp,
  CircleCheck,
  CircleDashed,
  CircleX,
  FilePen,
  Files,
  GitCommitHorizontal,
  GitPullRequest,
  Link as LinkIcon,
  MessageSquare,
  Moon,
  Play,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { describeEvent, statusBadges, type BadgeId } from '../../../src/server/activity.ts';
import { fetchActivity, type ActivityEvent, type ProjectActivity, type ProjectDto } from '../api.ts';
import { ago } from '../ui.tsx';

/** Newest activity per project, refetched on every change (files included). */
export const useActivity = () => useQuery({ queryKey: ['activity'], queryFn: fetchActivity }).data;

const look: Record<BadgeId | 'archived', { Icon: LucideIcon; cls: string }> = {
  running: { Icon: Play, cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' },
  'ci-failing': { Icon: CircleX, cls: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  prs: { Icon: GitPullRequest, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  uncommitted: { Icon: FilePen, cls: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  'to-push': { Icon: ArrowUp, cls: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' },
  stale: { Icon: Moon, cls: 'bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400' },
  archived: { Icon: Archive, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
};

function Pill({ id, label }: { id: BadgeId | 'archived'; label: string }) {
  const { Icon, cls } = look[id];
  return (
    <span data-badge={id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      {label}
    </span>
  );
}

/** Every badge that applies, in priority order; archived comes first when it applies. */
export function StatusBadges({ project, activity }: { project: ProjectDto; activity?: ProjectActivity }) {
  const stale = !project.archived && !!activity?.stale;
  const badges = statusBadges(project, stale).map((b) => (b.id === 'stale' && activity?.last ? { ...b, label: `stale · ${ago(activity.last.at).replace(' ago', '')}` } : b));
  if (!project.archived && badges.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="status-badges">
      {project.archived && <Pill id="archived" label="archived" />}
      {badges.map((b) => (
        <Pill key={b.id} id={b.id} label={b.label} />
      ))}
    </div>
  );
}

/** The icon and colour for one timeline event. */
export function eventIcon(e: ActivityEvent): { Icon: LucideIcon; cls: string } {
  switch (e.kind) {
    case 'session':
      return e.state === 'running' ? { Icon: Play, cls: 'text-green-600 dark:text-green-400' } : { Icon: Terminal, cls: 'text-stone-500' };
    case 'chat':
      return { Icon: MessageSquare, cls: 'text-orange-600 dark:text-orange-400' };
    case 'commit':
      return { Icon: GitCommitHorizontal, cls: 'text-stone-500' };
    case 'ci':
      return e.state === 'passing'
        ? { Icon: CircleCheck, cls: 'text-green-600 dark:text-green-400' }
        : e.state === 'failing'
          ? { Icon: CircleX, cls: 'text-red-600 dark:text-red-400' }
          : { Icon: CircleDashed, cls: 'text-amber-600 dark:text-amber-400' };
    case 'files':
      return { Icon: Files, cls: 'text-sky-600 dark:text-sky-400' };
    case 'link':
      return { Icon: LinkIcon, cls: 'text-violet-600 dark:text-violet-400' };
  }
}

/** "Last: session "Add CI to card" · 4m ago", with the event's icon. */
export function LastActivity({ last }: { last: ActivityEvent | null | undefined }) {
  if (last === undefined) return null;
  if (last === null) return <p className="text-sm text-stone-500">No activity yet</p>;
  const { Icon, cls } = eventIcon(last);
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-sm" data-testid="last-activity" title={new Date(last.at).toLocaleString()}>
      <Icon size={14} className={`shrink-0 ${cls}`} aria-hidden />
      <span className="truncate">
        <span className="text-stone-500">Last:</span> {describeEvent(last)}
      </span>
      <span className="shrink-0 text-stone-500">· {ago(last.at)}</span>
    </p>
  );
}

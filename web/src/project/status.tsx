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
import { CHART } from '../colors.ts';
import { ago } from '../ui.tsx';

/** Newest activity per project, refetched on every change (files included). */
export const useActivity = () => useQuery({ queryKey: ['activity'], queryFn: fetchActivity }).data;

const look: Record<BadgeId | 'archived', { Icon: LucideIcon; cls: string }> = {
  running: { Icon: Play, cls: 'bg-live-bg text-live' },
  'ci-failing': { Icon: CircleX, cls: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  prs: { Icon: GitPullRequest, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  uncommitted: { Icon: FilePen, cls: 'bg-warn-bg text-warn' },
  'to-push': { Icon: ArrowUp, cls: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' },
  stale: { Icon: Moon, cls: 'bg-track text-muted' },
  archived: { Icon: Archive, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
};

function Pill({ id, label }: { id: BadgeId | 'archived'; label: string }) {
  const { Icon, cls } = look[id];
  return (
    <span data-badge={id} className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${cls}`}>
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      {label}
    </span>
  );
}

/** Every badge that applies, in priority order; archived comes first when it applies. */
export function StatusBadges({ project, activity, omit = [] }: { project: ProjectDto; activity?: ProjectActivity; omit?: BadgeId[] }) {
  const stale = !project.archived && !!activity?.stale;
  const badges = statusBadges(project, stale).filter((b) => !omit.includes(b.id)).map((b) => (b.id === 'stale' && activity?.last ? { ...b, label: `stale · ${ago(activity.last.at).replace(' ago', '')}` } : b));
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

/** Each event kind's colour (the chart palette), used for timeline chips and charts. */
export function eventColor(e: ActivityEvent): string {
  switch (e.kind) {
    case 'session':
      return CHART.sessions;
    case 'chat':
      return CHART.chats;
    case 'commit':
      return CHART.commits;
    case 'files':
      return CHART.files;
    case 'link':
      return '#7B61E8';
    case 'ci':
      return e.state === 'passing' ? '#16A34A' : e.state === 'failing' ? '#DC2626' : '#E0A21B';
  }
}

/** The icon and colour for one timeline event. */
export function eventIcon(e: ActivityEvent): { Icon: LucideIcon; cls: string } {
  switch (e.kind) {
    case 'session':
      return e.state === 'running' ? { Icon: Play, cls: 'text-live' } : { Icon: Terminal, cls: 'text-[#3E63DD] dark:text-[#8aa2f0]' };
    case 'chat':
      return { Icon: MessageSquare, cls: 'text-[#B4441B] dark:text-[#f0916d]' };
    case 'commit':
      return { Icon: GitCommitHorizontal, cls: 'text-[#136F66] dark:text-[#5fd0c4]' };
    case 'ci':
      return e.state === 'passing'
        ? { Icon: CircleCheck, cls: 'text-live' }
        : e.state === 'failing'
          ? { Icon: CircleX, cls: 'text-red-600 dark:text-red-400' }
          : { Icon: CircleDashed, cls: 'text-warn' };
    case 'files':
      return { Icon: Files, cls: 'text-[#8A5E00] dark:text-[#f0c35a]' };
    case 'link':
      return { Icon: LinkIcon, cls: 'text-[#5236C9] dark:text-[#a594f0]' };
  }
}

/**
 * "Last: session "Add CI to card" · 4m ago", with the event's icon. `strip`
 * puts it on a soft grey band with a mono time, for cards and headers.
 */
export function LastActivity({ last, strip }: { last: ActivityEvent | null | undefined; strip?: boolean }) {
  if (last === undefined) return null;
  if (last === null)
    return <p className={strip ? 'rounded-[9px] bg-soft px-2.5 py-1.5 text-meta text-muted' : 'text-meta text-muted'}>No activity yet</p>;
  const { Icon, cls } = eventIcon(last);
  return (
    <p
      className={`flex min-w-0 items-center gap-1.5 ${strip ? 'rounded-[9px] bg-soft px-2.5 py-1.5 text-meta' : 'text-[13px]'}`}
      data-testid="last-activity"
      title={new Date(last.at).toLocaleString()}
    >
      <Icon size={14} className={`shrink-0 ${cls}`} aria-hidden />
      <span className="min-w-0 truncate">
        <span className="text-muted">Last:</span> {describeEvent(last)}
      </span>
      <span className={`ml-auto shrink-0 text-muted ${strip ? 'font-mono text-tiny' : ''}`}>{strip ? ago(last.at) : `· ${ago(last.at)}`}</span>
    </p>
  );
}

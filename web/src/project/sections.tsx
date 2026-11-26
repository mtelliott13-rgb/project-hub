// The sections of a project page, in order. To add one: write a component that
// takes { project, run } and add a line to SECTIONS. `main` is the wide left
// column, `side` the narrow right one. Each section folds away; `defaultOpen`
// says how it starts, and `summary(p)` is the one line shown while it's closed.
import { useQuery } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import { describeEvent } from '../../../src/server/activity.ts';
import { fetchCollector, fetchFiles, fetchMonetize, type ProjectDto } from '../api.ts';
import { runningCounts, runningLabel } from '../colors.ts';
import { ProjectIdeas } from '../IdeasPage.tsx';
import { ago } from '../ui.tsx';
import { ActivitySection } from './ActivitySection.tsx';
import { ApplicationsSection } from './ApplicationsSection.tsx';
import { ChatsSection } from './ChatsSection.tsx';
import { CollectorSection } from './CollectorSection.tsx';
import { FilesSection } from './FilesSection.tsx';
import { JobFeedSection } from './JobFeedSection.tsx';
import { LinksSection } from './LinksSection.tsx';
import { MonetizeSection } from './MonetizeSection.tsx';
import { RepoSection } from './RepoSection.tsx';
import { ToolkitSection } from './ToolkitSection.tsx';
import { NotesSection } from './NotesSection.tsx';
import { UpcomingSection, UpcomingSummary } from './UpcomingSection.tsx';
import { listedSessions, SessionList, type Run } from './parts.tsx';
import { useActivity } from './status.tsx';

export type SectionProps = { project: ProjectDto; run: Run };

export type Section = {
  id: string;
  title: (p: ProjectDto) => string;
  column: 'main' | 'side';
  Component: ComponentType<SectionProps>;
  /** Show only for some projects; shown for all when absent. */
  show?: (p: ProjectDto) => boolean;
  /** Open the first time the page is shown (then remembered per project). Defaults to true. */
  defaultOpen?: boolean;
  /** One line shown in the header while the section is closed. */
  summary?: (p: ProjectDto) => ReactNode;
  /** Shown in the header while open. */
  hint?: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function repoSummary(p: ProjectDto): string {
  const repos = p.repoStatus.filter((r) => r?.git);
  if (p.repos.length === 0) return 'No repos';
  if (repos.length === 0) return 'Checking…';
  const uncommitted = repos.reduce((n, r) => n + (r?.git?.uncommitted ?? 0), 0);
  const prs = repos.reduce((n, r) => n + (r?.github?.prs.length ?? 0), 0);
  const ci = repos.map((r) => r?.github?.ci?.state).find((s) => s && s !== 'none');
  return [uncommitted ? `${uncommitted} uncommitted` : 'clean', prs ? `${plural(prs, 'open PR')}` : 'no open PRs', ...(ci ? [`CI ${ci === 'pending' ? 'running' : ci}`] : [])].join(' · ');
}

// Summaries that need data the project list doesn't carry. They share the
// sections' own query keys, so opening the section reuses the answer.
function FilesSummary({ slug }: { slug: string }) {
  const newest = useQuery({ queryKey: ['files', slug], queryFn: () => fetchFiles(slug) }).data?.files[0];
  return <>{newest ? `${newest.rel.split('/').pop()} · ${ago(newest.mtime)}` : 'Nothing changed yet'}</>;
}

function MonetizeSummary({ slug }: { slug: string }) {
  const data = useQuery({ queryKey: ['monetize', slug], queryFn: () => fetchMonetize(slug) }).data;
  if (!data) return null;
  if (data.job?.state === 'running') return <>Generating…</>;
  const newest = data.drafts[0];
  return <>{newest ? `${plural(data.drafts.length, 'draft')} · newest ${ago(newest.generatedAt)}` : 'No drafts yet'}</>;
}

function CollectorSummary({ slug }: { slug: string }) {
  const s = useQuery({ queryKey: ['collector', slug], queryFn: () => fetchCollector(slug) }).data;
  if (!s) return null;
  const words = { running: 'Running', stopped: 'Stopped', starting: 'Starting', 'port-busy': 'Port busy' } as const;
  return <>{`${words[s.state]} · port ${s.port}`}</>;
}

function TimelineSummary({ slug }: { slug: string }) {
  const last = useActivity()?.[slug]?.last;
  return <>{last ? `Last: ${describeEvent(last)} · ${ago(last.at)}` : 'Nothing yet'}</>;
}

export const SECTIONS: Section[] = [
  {
    id: 'sessions',
    title: () => 'Sessions',
    column: 'main',
    Component: ({ project, run }) => <SessionList sessions={project.sessions} run={run} preview={10} />,
    summary: (p) => {
      const c = runningCounts(p.sessions);
      return `${plural(listedSessions(p).length, 'session')}${c.running ? ` · ${runningLabel(c)}` : ''}`;
    },
  },
  { id: 'activity', title: () => 'Timeline', column: 'main', Component: ActivitySection, summary: (p) => <TimelineSummary slug={p.slug} /> },
  {
    id: 'applications',
    title: () => 'Applications',
    column: 'main',
    Component: ApplicationsSection,
    show: (p) => p.applications !== null,
    defaultOpen: false,
    summary: (p) => (p.applications?.error ? "Queue can't be read" : (p.applications?.summary ?? 'None yet')),
  },
  {
    id: 'job-feed',
    title: (p) => `Job feed${p.jobFeed && !p.jobFeed.error ? ` (${p.jobFeed.postings})` : ''}`,
    column: 'main',
    Component: JobFeedSection,
    show: (p) => p.jobFeed !== null,
    defaultOpen: false,
    summary: (p) => (p.jobFeed?.error ? "Feed can't be read" : `${plural(p.jobFeed?.postings ?? 0, 'posting')}${p.jobFeed?.generated ? ` · updated ${ago(p.jobFeed.generated)}` : ''}`),
  },
  {
    id: 'toolkit',
    title: () => 'Toolkit details',
    column: 'main',
    Component: ToolkitSection,
    show: (p) => p.toolkit !== null,
    defaultOpen: false,
    summary: (p) => (p.toolkit?.error ? "toolkit.yaml can't be read" : `${p.toolkit?.done} of ${p.toolkit?.total} done`),
  },
  { id: 'repo', title: () => 'Commits and PRs', column: 'main', Component: RepoSection, defaultOpen: false, summary: repoSummary },
  { id: 'files', title: () => 'Recent files', column: 'main', Component: FilesSection, defaultOpen: false, summary: (p) => <FilesSummary slug={p.slug} /> },
  {
    id: 'chats',
    title: (p) => `Chats (${p.chats.length})`,
    column: 'main',
    Component: ChatsSection,
    defaultOpen: false,
    summary: (p) => (p.chats[0] ? `Last chat ${ago(p.chats[0].lastActiveAt)}` : 'No chats yet'),
  },
  { id: 'monetize', title: () => 'Monetize', column: 'main', Component: MonetizeSection, defaultOpen: false, summary: (p) => <MonetizeSummary slug={p.slug} /> },
  {
    id: 'collector',
    title: () => 'Collector',
    column: 'main',
    Component: CollectorSection,
    show: (p) => p.collector !== null,
    defaultOpen: false,
    summary: (p) => <CollectorSummary slug={p.slug} />,
  },
  { id: 'upcoming', title: () => 'Upcoming', column: 'side', Component: UpcomingSection, defaultOpen: false, summary: (p) => <UpcomingSummary slug={p.slug} /> },
  { id: 'notes', title: () => 'Notes', column: 'side', Component: NotesSection, hint: 'Autosaves' },
  { id: 'links', title: () => 'Links', column: 'side', Component: LinksSection },
  { id: 'ideas', title: () => 'Ideas', column: 'side', Component: ProjectIdeas },
];

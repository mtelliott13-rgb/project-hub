// The sections of a project page, in order. To add one: write a component that
// takes { project, run } and add a line to SECTIONS. `main` is the wide left
// column, `side` the narrow right one.
import type { ComponentType } from 'react';
import type { ProjectDto } from '../api.ts';
import { ProjectIdeas } from '../IdeasPage.tsx';
import { ActivitySection } from './ActivitySection.tsx';
import { ChatsSection } from './ChatsSection.tsx';
import { CollectorSection } from './CollectorSection.tsx';
import { FilesSection } from './FilesSection.tsx';
import { LinksSection } from './LinksSection.tsx';
import { MonetizeSection } from './MonetizeSection.tsx';
import { RepoSection } from './RepoSection.tsx';
import { ToolkitSection } from './ToolkitSection.tsx';
import { NotesSection } from './NotesSection.tsx';
import { listedSessions, SessionList, type Run } from './parts.tsx';

export type SectionProps = { project: ProjectDto; run: Run };

export type Section = {
  id: string;
  title: (p: ProjectDto) => string;
  column: 'main' | 'side';
  Component: ComponentType<SectionProps>;
  /** Show only for some projects; shown for all when absent. */
  show?: (p: ProjectDto) => boolean;
};


export const SECTIONS: Section[] = [
  { id: 'activity', title: () => 'Activity', column: 'main', Component: ActivitySection },
  {
    id: 'sessions',
    title: (p) => `Sessions (${listedSessions(p).length})`,
    column: 'main',
    Component: ({ project, run }) => <SessionList sessions={project.sessions} run={run} preview={10} />,
  },
  { id: 'collector', title: () => 'Collector', column: 'main', Component: CollectorSection, show: (p) => p.collector !== null },
  { id: 'toolkit', title: () => 'Toolkit', column: 'main', Component: ToolkitSection, show: (p) => p.toolkit !== null },
  { id: 'monetize', title: () => 'Monetize', column: 'main', Component: MonetizeSection },
  { id: 'repo', title: () => 'Commits and PRs', column: 'main', Component: RepoSection },
  { id: 'files', title: () => 'Recent files', column: 'main', Component: FilesSection },
  { id: 'chats', title: (p) => `Chats (${p.chats.length})`, column: 'main', Component: ChatsSection },
  { id: 'links', title: () => 'Links', column: 'side', Component: LinksSection },
  { id: 'notes', title: () => 'Notes', column: 'side', Component: NotesSection },
  { id: 'ideas', title: () => 'Ideas for this project', column: 'side', Component: ProjectIdeas },
];

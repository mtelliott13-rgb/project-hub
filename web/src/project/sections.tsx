// The sections of a project page, in order. To add one: write a component that
// takes { project, run } and add a line to SECTIONS. `main` is the wide left
// column, `side` the narrow right one.
import type { ComponentType } from 'react';
import type { ProjectDto } from '../api.ts';
import { ProjectIdeas } from '../IdeasPage.tsx';
import { MonetizeSection } from './MonetizeSection.tsx';
import { NotesSection } from './NotesSection.tsx';
import { listedSessions, SessionList, type Run } from './parts.tsx';

export type SectionProps = { project: ProjectDto; run: Run };

export type Section = {
  id: string;
  title: (p: ProjectDto) => string;
  column: 'main' | 'side';
  Component: ComponentType<SectionProps>;
};

/** Space kept for what a later phase adds. */
const comingIn = (phase: number, what: string) =>
  function ComingSoon() {
    return (
      <p className="text-sm text-stone-500">
        {what} arrive in Phase {phase}.
      </p>
    );
  };

export const SECTIONS: Section[] = [
  {
    id: 'sessions',
    title: (p) => `Sessions (${listedSessions(p).length})`,
    column: 'main',
    Component: ({ project, run }) => <SessionList sessions={project.sessions} run={run} preview={10} />,
  },
  { id: 'monetize', title: () => 'Monetize', column: 'main', Component: MonetizeSection },
  { id: 'repo', title: () => 'Commits and PRs', column: 'main', Component: comingIn(5, 'Branch, commits, PRs and CI') },
  { id: 'files', title: () => 'Files and links', column: 'main', Component: comingIn(6, 'Recently changed files and saved links') },
  { id: 'chats', title: () => 'Chats', column: 'main', Component: comingIn(7, 'claude.ai chats for this project') },
  { id: 'notes', title: () => 'Notes', column: 'side', Component: NotesSection },
  { id: 'ideas', title: () => 'Ideas for this project', column: 'side', Component: ProjectIdeas },
];

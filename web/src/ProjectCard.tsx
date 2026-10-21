// One card on the home page. Clicking its name or any empty part of it opens the project's page.
import type { MouseEvent } from 'react';
import type { ProjectDto } from './api.ts';
import { listedSessions, openProject, ProjectActions, ProjectMenu, SessionList, StatusBadge, type Run } from './project/parts.tsx';
import { Link } from './router.tsx';
import { Row, shortenHome } from './ui.tsx';

export type { Run };

export function ProjectCard({ project: p, run }: { project: ProjectDto; run: Run }) {
  const running = p.sessions.some((s) => s.state === 'running');
  // Buttons, links and dialogs inside the card keep doing their own thing.
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [role=dialog]') || getSelection()?.toString()) return;
    openProject(p.slug);
  };

  return (
    <li
      data-testid="project-card"
      data-status={running ? 'running' : p.sessions.length ? 'ended' : 'none'}
      onClick={onClick}
      className={`cursor-pointer rounded-lg border border-stone-200 bg-white p-4 hover:border-stone-400 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-600 ${p.archived ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">
            <Link to={`/p/${p.slug}`} className="hover:underline">
              {p.name}
            </Link>
          </h2>
          <p className="font-mono text-xs text-stone-500">{p.slug}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge project={p} />
          <ProjectMenu project={p} />
        </div>
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        {p.repos.length > 0 && <Row label="Repo" values={p.repos.map(shortenHome)} />}
        {p.folders.length > 0 && <Row label="Folders" values={p.folders.map(shortenHome)} />}
        {p.github.length > 0 && <Row label="GitHub" values={p.github} />}
        {p.keywords.length > 0 && <Row label="Keywords" values={p.keywords} />}
      </dl>
      <div className="mt-3">
        <ProjectActions project={p} run={run} />
      </div>
      <h3 className="mt-4 text-xs font-medium tracking-wide text-stone-500 uppercase">Sessions ({listedSessions(p).length})</h3>
      <SessionList sessions={p.sessions} run={run} preview={5} />
    </li>
  );
}

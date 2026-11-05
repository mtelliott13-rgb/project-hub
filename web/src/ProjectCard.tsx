// One card on the home page. Clicking its name or any empty part of it opens the project's page.
import type { MouseEvent } from 'react';
import type { ProjectActivity, ProjectDto } from './api.ts';
import { listedSessions, openProject, ProjectActions, ProjectMenu, SessionList, type Run } from './project/parts.tsx';
import { LastActivity, StatusBadges } from './project/status.tsx';
import { Link } from './router.tsx';
import { checkLook, repoFacts } from './project/RepoSection.tsx';

export type { Run };

export function ProjectCard({ project: p, run, activity }: { project: ProjectDto; run: Run; activity?: ProjectActivity }) {
  const running = p.sessions.some((s) => s.state === 'running');
  const stale = !p.archived && !!activity?.stale;
  // Buttons, links and dialogs inside the card keep doing their own thing.
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [role=dialog]') || getSelection()?.toString()) return;
    openProject(p.slug);
  };
  const multi = p.repos.length > 1;

  return (
    <li
      data-testid="project-card"
      data-status={running ? 'running' : p.sessions.length ? 'ended' : 'none'}
      data-stale={stale || undefined}
      onClick={onClick}
      className={`cursor-pointer rounded-lg border border-stone-200 bg-white p-4 transition-opacity hover:border-stone-400 hover:opacity-100 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-600 ${p.archived ? 'opacity-70' : stale ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 truncate text-lg font-medium">
          <Link to={`/p/${p.slug}`} className="hover:underline">
            {p.name}
          </Link>
        </h2>
        <ProjectMenu project={p} />
      </div>
      <LastActivity last={activity ? activity.last : undefined} />
      <div className="mt-2">
        <StatusBadges project={p} activity={activity} />
      </div>
      {p.repoStatus.some((s) => s?.git) && (
        <ul className="mt-2 space-y-0.5 text-xs text-stone-600 dark:text-stone-400" data-testid="card-repos">
          {p.repoStatus.map((s, i) =>
            s?.git ? (
              <li key={p.repos[i]} className="truncate">
                {multi && <span className="font-mono">{p.repos[i].split('/').pop()}: </span>}
                {repoFacts(s, { badged: false }).join(' · ')}
                {s.github?.ci && (
                  <>
                    {' · '}
                    <a href={s.github.ci.url} target="_blank" rel="noreferrer" className={`hover:underline ${checkLook[s.github.ci.state].text}`} data-testid="card-ci">
                      {checkLook[s.github.ci.state].label}
                    </a>
                  </>
                )}
              </li>
            ) : null,
          )}
        </ul>
      )}
      {p.toolkit && (
        <p className="mt-1 text-xs text-stone-600 dark:text-stone-400" data-testid="card-toolkit" title={p.toolkit.error ?? p.toolkit.file}>
          {p.toolkit.error ? (
            <span className="text-amber-700">Toolkit: toolkit.yaml can't be read</span>
          ) : (
            <>
              Toolkit: {p.toolkit.done} of {p.toolkit.total} done
            </>
          )}
        </p>
      )}
      {p.applications && (
        <p className="mt-1 text-xs text-stone-600 dark:text-stone-400" data-testid="card-applications">
          {p.applications.error ? <span className="text-amber-700">Applications: review_queue.yaml can't be read</span> : <>Applications: {p.applications.summary}</>}
        </p>
      )}
      <div className="mt-3">
        <ProjectActions project={p} run={run} />
      </div>
      {listedSessions(p).length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-medium tracking-wide text-stone-500 uppercase">Sessions ({listedSessions(p).length})</h3>
          <SessionList sessions={p.sessions} run={run} preview={3} />
        </>
      )}
    </li>
  );
}

// One card on the home page (v4). Clicking its name or any empty part of it
// opens the project's page. Sessions are listed on the project page, not here.
import { Star } from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';
import type { ProjectActivity, ProjectDto } from './api.ts';
import { runningCounts, runningLabel, tint } from './colors.ts';
import { PINS_KEY } from './home/model.ts';
import { openProject, ProjectActions, ProjectMenu, type Run } from './project/parts.tsx';
import { checkLook, repoFacts } from './project/RepoSection.tsx';
import { LastActivity, StatusBadges } from './project/status.tsx';
import { Link } from './router.tsx';
import { PingDot, ProjectChip, projectColor, useStoredList } from './ui.tsx';

export type { Run };

/** "2 running", "2 running (1 idle)", "3 uncommitted" or "Nothing running". */
export function CardStatus({ project: p }: { project: ProjectDto }) {
  const counts = runningCounts(p.sessions);
  const uncommitted = p.repoStatus.reduce((n, r) => n + (r?.git?.uncommitted ?? 0), 0);
  if (counts.running)
    return (
      <span className={`flex items-center gap-1.5 text-meta font-medium ${counts.idle === counts.running ? 'text-warn' : 'text-live'}`} data-testid="card-status">
        <PingDot idle={counts.idle === counts.running} />
        {runningLabel(counts)}
      </span>
    );
  if (uncommitted)
    return (
      <span className="flex items-center gap-1.5 text-meta font-medium text-warn" data-testid="card-status">
        <span className="size-2 rounded-full bg-amber-500" aria-hidden />
        {uncommitted} uncommitted
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-meta text-muted" data-testid="card-status">
      <span className="size-2 rounded-full border border-control bg-track" aria-hidden />
      Nothing running
    </span>
  );
}

export function ProjectCard({ project: p, run, activity, pinned }: { project: ProjectDto; run: Run; activity?: ProjectActivity; pinned?: boolean }) {
  const [pins, setPins] = useStoredList(PINS_KEY);
  const running = p.sessions.some((s) => s.state === 'running');
  const stale = !p.archived && !!activity?.stale;
  const color = projectColor(p.slug);
  // Buttons, links and dialogs inside the card keep doing their own thing.
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [role=dialog], [role=menu]') || getSelection()?.toString()) return;
    openProject(p.slug);
  };
  // The soft glow in the project's colour follows the cursor.
  const onMove = (e: MouseEvent<HTMLLIElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  const togglePin = () => setPins(pins.includes(p.slug) ? pins.filter((s) => s !== p.slug) : [...pins, p.slug]);
  const multi = p.repos.length > 1;
  const pct = p.toolkit && !p.toolkit.error && p.toolkit.total ? (p.toolkit.done / p.toolkit.total) * 100 : 0;
  // Badges the status line doesn't already say.
  const omit = ['running', 'uncommitted'] as const;

  return (
    <li
      data-testid="project-card"
      data-status={running ? 'running' : p.sessions.length ? 'ended' : 'none'}
      data-stale={stale || undefined}
      onClick={onClick}
      onMouseMove={onMove}
      style={{ '--glow': tint(color.base, 0.12) } as CSSProperties}
      className={`group/card hub-fade-up relative isolate flex cursor-pointer flex-col gap-3 overflow-hidden rounded-card border border-line bg-card p-4 shadow-card transition duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-lift ${p.archived ? 'opacity-70' : stale ? 'opacity-75' : ''}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover/card:opacity-100"
        style={{ background: 'radial-gradient(220px circle at var(--mx, 50%) var(--my, 0%), var(--glow), transparent 70%)' }}
      />
      <div className="flex items-start gap-3">
        <ProjectChip slug={p.slug} name={p.name} size={38} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] leading-5 font-semibold">
            <Link to={`/p/${p.slug}`} className="hover:underline">
              {p.name}
            </Link>
          </h2>
          <div className="mt-0.5">
            <CardStatus project={p} />
          </div>
        </div>
        <button
          type="button"
          aria-pressed={!!pinned}
          aria-label={pinned ? `Unpin ${p.name}` : `Pin ${p.name} to the top`}
          title={pinned ? 'Unpin' : 'Pin to the top'}
          onClick={togglePin}
          className={`inline-flex size-8 items-center justify-center rounded-[9px] transition hover:bg-soft ${pinned ? 'text-amber-500' : 'text-muted hover:text-ink'}`}
        >
          <Star size={16} aria-hidden fill={pinned ? 'currentColor' : 'none'} />
        </button>
        <ProjectMenu project={p} />
      </div>

      <LastActivity last={activity ? activity.last : undefined} strip />

      <StatusBadges project={p} activity={activity} omit={[...omit]} />

      {p.repoStatus.some((s) => s?.git) && (
        <ul className="-mt-1 space-y-0.5 text-meta text-muted" data-testid="card-repos">
          {p.repoStatus.map((s, i) =>
            s?.git ? (
              <li key={p.repos[i]} className="truncate">
                {multi && <span className="font-mono">{p.repos[i].split('/').pop()}: </span>}
                <span className="font-mono text-tiny">{repoFacts(s, { badged: false }).join(' · ')}</span>
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
        <div data-testid="card-toolkit" title={p.toolkit.error ?? p.toolkit.file}>
          {p.toolkit.error ? (
            <p className="text-meta text-warn">Toolkit: toolkit.yaml can't be read</p>
          ) : (
            <>
              <div className="flex justify-between text-meta">
                <span className="text-muted">Toolkit</span>
                <span className="tnum font-medium">
                  {p.toolkit.done} of {p.toolkit.total} done
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-track" role="progressbar" aria-label="Toolkit progress" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                <div className="hub-grow relative h-full overflow-hidden rounded-pill" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${tint(color.base, 0.7)}, ${color.base})` }}>
                  <span aria-hidden className="hub-shimmer absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {p.applications && (
        <p className="text-meta text-muted" data-testid="card-applications">
          {p.applications.error ? <span className="text-warn">Applications: review_queue.yaml can't be read</span> : <>Applications: {p.applications.summary}</>}
        </p>
      )}

      <div className="mt-auto pt-1">
        <ProjectActions project={p} run={run} variant="card" />
      </div>
    </li>
  );
}

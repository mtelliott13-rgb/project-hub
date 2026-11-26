// The Today page: welcome banner with a one-line summary, the quick-add bar,
// then the Agenda and Tasks cards, then "Pick up where you left off" and what's
// running. Laid out as a grid so later cards (email, portfolio, news) slot in
// as more children of the main or lower row, with no placeholders until then.
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { fetchCalendar, fetchProjects, fetchTasks, type ProjectDto } from '../api.ts';
import { runningLabel, sessionTag } from '../colors.ts';
import { PickUp, Welcome } from '../home/HomePage.tsx';
import { homeStats } from '../home/model.ts';
import type { Run } from '../project/parts.tsx';
import { useActivity } from '../project/status.tsx';
import { Link } from '../router.tsx';
import { Card, PingDot, ProjectChip } from '../ui.tsx';
import { AgendaCard, useNow } from './Agenda.tsx';
import { TasksCard } from './Tasks.tsx';
import { agenda, openTasks, todaySummary } from './model.ts';

export function TodayPage({ run }: { run: Run }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const calendar = useQuery({ queryKey: ['calendar'], queryFn: () => fetchCalendar() });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => fetchTasks() });
  const activity = useActivity();
  const now = useNow();
  const active = (projects.data ?? []).filter((p) => !p.archived);
  const stats = homeStats(active, activity);
  const g = calendar.data?.google;
  const calendarShown = !!g && (g.state !== 'not-set-up' || g.sample);
  const summary = todaySummary({
    eventsToday: calendarShown ? agenda(calendar.data!.events, now).today.length : null,
    openTasks: openTasks(tasks.data ?? []).length,
    running: stats.running,
    idle: stats.idle,
  });
  const calendarReady = !!g && (g.sample || g.state === 'connected' || g.state === 'error');

  return (
    <div className="space-y-5" data-testid="today-page">
      <Welcome projects={active} stats={stats} run={run} summary={summary} pickUp={false} />
      <QuickAddBar />
      {/* Main row: Agenda (two columns wide) and Tasks. Later cards join this grid. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <AgendaCard data={calendar.data} projects={active} error={calendar.error} />
        <TasksCard tasks={tasks.data ?? []} projects={active} calendarReady={calendarReady} />
      </div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card className="p-5" data-testid="today-pickup">
          <PickUp projects={active} run={run} />
        </Card>
        <RunningCard projects={active} />
      </div>
    </div>
  );
}

/** The quick-add bar. Phase 4 sends what you type to the parser; for now it only holds the text. */
function QuickAddBar() {
  const [text, setText] = useState('');
  return (
    <form
      className="flex items-center gap-3 rounded-card border border-line bg-card px-4 py-3 shadow-card focus-within:border-accent"
      role="search"
      aria-label="Quick add"
      onSubmit={(e) => e.preventDefault()}
      data-testid="quick-add"
    >
      <Plus size={18} aria-hidden className="shrink-0 text-muted" />
      <label htmlFor="quick-add-input" className="sr-only">
        Add a reminder or task
      </label>
      <input
        id="quick-add-input"
        className="h-9 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-muted focus-visible:outline-none"
        placeholder="Add a reminder or task, like 'Fidelity call Fri 3pm'"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
      />
    </form>
  );
}

/** Running sessions, newest first, linking to their projects. */
function RunningCard({ projects }: { projects: ProjectDto[] }) {
  const running = projects
    .flatMap((p) => p.sessions.filter((s) => s.state === 'running').map((s) => ({ s, p })))
    .sort((a, b) => Date.parse(b.s.lastActiveAt) - Date.parse(a.s.lastActiveAt));
  const idle = running.filter(({ s }) => sessionTag(s) !== 'Running').length;
  return (
    <Card className="p-5" data-testid="today-running">
      <p className="text-tiny font-semibold tracking-[0.08em] text-muted uppercase">Running now</p>
      {running.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">No sessions running.</p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink" data-testid="running-line">
            {runningLabel({ running: running.length, idle })} session{running.length === 1 ? '' : 's'}
          </p>
          <ul className="mt-2 space-y-1.5">
            {running.slice(0, 4).map(({ s, p }) => {
              const tag = sessionTag(s);
              return (
                <li key={s.id} className="flex items-center gap-2 text-[13px]">
                  <PingDot idle={tag !== 'Running'} />
                  <ProjectChip slug={p.slug} name={p.name} size={20} />
                  <Link to={`/p/${p.slug}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
                    {s.title ?? 'Untitled session'}
                    <span className="text-muted"> · {p.name}</span>
                  </Link>
                  <span className="shrink-0 text-[12px] text-muted">{tag}</span>
                </li>
              );
            })}
          </ul>
          {running.length > 4 && <p className="mt-1 text-[12px] text-muted">and {running.length - 4} more</p>}
        </>
      )}
    </Card>
  );
}

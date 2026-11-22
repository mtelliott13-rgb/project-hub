// The home page (v4): welcome banner with the newest thing to pick up, four stat
// tiles, the project constellation with running-sessions and toolkit charts,
// then the project cards in collapsible groups.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CornerDownLeft, Play } from 'lucide-react';
import { useState } from 'react';
import { describeEvent, sortProjects } from '../../../src/server/activity.ts';
import { archiveProject, fetchProjects, type ProjectActivity, type ProjectDto } from '../api.ts';
import { Donut, HalfGauge, MiniBars, Ring, Swatch } from '../charts.tsx';
import { dayPart, projectColor, runningLabel, type DayPart } from '../colors.ts';
import { ProjectCard } from '../ProjectCard.tsx';
import { resume, type Run } from '../project/parts.tsx';
import { useActivity } from '../project/status.tsx';
import { Link } from '../router.tsx';
import { ago, Card, CollapsibleSection, PrimaryButton, ProjectChip, useCountUp, useStoredList } from '../ui.tsx';
import { Constellation } from './Constellation.tsx';
import { homeStats, newestPickUp, PINS_KEY, tierOf, type HomeStats } from './model.ts';


export function HomePage({ run }: { run: Run }) {
  const { data, error, isPending } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const activity = useActivity();
  const [pins] = useStoredList(PINS_KEY);
  const [showArchived, setShowArchived] = useState(false);
  const sorted = sortProjects(data ?? [], activity, (p) => p.slug);
  const active = sorted.filter((p) => !p.archived);
  const archived = sorted.filter((p) => p.archived);
  const stats = homeStats(active, activity);

  const pinned = active.filter((p) => pins.includes(p.slug));
  const rest = active.filter((p) => !pins.includes(p.slug));
  const running = rest.filter((p) => tierOf(p, activity) === 'running');
  const recent = rest.filter((p) => tierOf(p, activity) === 'recent');
  const quiet = rest.filter((p) => tierOf(p, activity) === 'quiet');

  const grid = (list: ProjectDto[]) => (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4">
      {list.map((p) => (
        <ProjectCard key={p.slug} project={p} run={run} activity={activity?.[p.slug]} pinned={pins.includes(p.slug)} />
      ))}
    </ul>
  );

  return (
    <div className="space-y-5">
      <Welcome projects={active} stats={stats} run={run} />
      {isPending && <p className="text-muted">Loading…</p>}
      {error && <p className="text-red-600">{error.message}</p>}
      {data && (
        <>
          <StatTiles stats={stats} />
          <div className="flex flex-wrap gap-5">
            <Constellation projects={active} activity={activity} />
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
              <RunningCard stats={stats} />
              <ToolkitCard stats={stats} />
            </div>
          </div>
          {active.length === 0 && <p className="text-muted">No projects yet. Use New project to make one.</p>}
          <div className="space-y-4">
            {pinned.length > 0 && (
              <CollapsibleSection scope="home" id="pinned" title="Pinned" count={pinned.length} framed={false} data-group="pinned">
                {grid(pinned)}
              </CollapsibleSection>
            )}
            {running.length > 0 && (
              <CollapsibleSection scope="home" id="running" title="Active now" count={running.length} framed={false} data-group="running">
                {grid(running)}
              </CollapsibleSection>
            )}
            {recent.length > 0 && (
              <CollapsibleSection scope="home" id="recent" title="Recent" count={recent.length} framed={false} data-group="recent">
                {grid(recent)}
              </CollapsibleSection>
            )}
            {quiet.length > 0 && (
              <CollapsibleSection scope="home" id="quiet" title="Quiet" count={quiet.length} framed={false} defaultOpen={false} data-group="quiet">
                <QuietList projects={quiet} activity={activity} />
              </CollapsibleSection>
            )}
          </div>
          {archived.length > 0 && (
            <section>
              <button type="button" className="text-meta text-muted hover:text-ink hover:underline" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
                {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
              </button>
              {showArchived && <div className="mt-3">{grid(archived)}</div>}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome banner

const BANNER: Record<DayPart, string> = {
  morning: 'linear-gradient(120deg, #E6F1FF, #F1F7FF 55%, #FFF5D9)',
  afternoon: 'linear-gradient(120deg, #E9EEFF, #F4F7FF 55%, #FFEFD8)',
  evening: 'linear-gradient(120deg, #E9E7FF, #F3EDFF 55%, #FFECE2)',
  night: 'linear-gradient(120deg, #E3E3FA, #ECE8FB 55%, #F6EAF3)',
};
const GREETING: Record<DayPart, string> = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Good evening' };

function Sky({ part }: { part: DayPart }) {
  if (part === 'evening' || part === 'night')
    return (
      <svg aria-hidden className="pointer-events-none absolute top-3 right-[42%] hidden h-24 w-40 md:block" viewBox="0 0 160 96">
        {[
          [18, 22, 1.6, 0],
          [52, 70, 1.2, 0.8],
          [128, 18, 1.4, 1.6],
          [146, 64, 1.1, 0.4],
          [96, 84, 1.3, 1.2],
        ].map(([x, y, r, d], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill="#7B61E8" className="hub-twinkle" style={{ animationDelay: `${d}s` }} />
        ))}
        <g className="hub-float">
          <path d="M92 20a26 26 0 1 0 22 40A22 22 0 1 1 92 20Z" fill="#FFF6D6" stroke="#E7D8A8" strokeWidth="1" />
        </g>
      </svg>
    );
  return (
    <svg aria-hidden className="pointer-events-none absolute top-2 right-[42%] hidden h-24 w-24 md:block" viewBox="0 0 96 96">
      <g className="hub-float">
        <circle cx="48" cy="48" r="30" fill="#FFD772" fillOpacity="0.35" />
        <circle cx="48" cy="48" r="20" fill="#FFC53D" />
      </g>
    </svg>
  );
}

function Welcome({ projects, stats, run }: { projects: ProjectDto[]; stats: HomeStats; run: Run }) {
  const now = new Date();
  const part = dayPart(now.getHours());
  const pick = newestPickUp(projects);
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const sessions = `${stats.running} session${stats.running === 1 ? '' : 's'}`;
  return (
    <section
      className="hub-fade-up relative flex flex-wrap items-center gap-5 overflow-hidden rounded-banner border border-line px-6 py-6 text-[#1F2329] shadow-card"
      style={{ background: BANNER[part] }}
      data-testid="welcome"
      data-daypart={part}
    >
      <Sky part={part} />
      <div className="relative min-w-0 flex-[1_1_320px]">
        <p className="text-tiny font-semibold tracking-[0.08em] text-[#4b5260] uppercase">{date}</p>
        <h1 className="mt-1 text-[28px] leading-tight font-bold">{GREETING[part]}</h1>
        <p className="mt-1 text-[14px] text-[#4b5260]">
          {stats.running === 0
            ? 'Nothing running right now.'
            : `${sessions} running${stats.idle ? ` (${stats.idle} idle)` : ''} across ${stats.runningProjects} project${stats.runningProjects === 1 ? '' : 's'}.`}
        </p>
      </div>
      <div className="relative w-full rounded-card bg-white/95 p-4 text-[#1F2329] shadow-lift sm:w-auto sm:min-w-[340px] sm:flex-[0_1_400px]">
        <p className="text-tiny font-semibold tracking-[0.08em] text-[#646A73] uppercase">Pick up where you left off</p>
        {pick ? (
          <div className="mt-2 flex items-center gap-3">
            <ProjectChip slug={pick.project.slug} name={pick.project.name} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold" data-testid="pickup-title">
                {(pick.target.kind === 'chat' ? pick.target.chat.title : pick.target.session.title) ?? (pick.target.kind === 'chat' ? 'Untitled chat' : 'Untitled session')}
              </p>
              <p className="truncate text-meta text-[#646A73]">
                {pick.target.kind === 'chat' ? 'Chat' : 'Session'} in {pick.project.name} · <span className="font-mono text-tiny">{ago(pick.at)}</span>
              </p>
            </div>
            <PrimaryButton onClick={() => resume(pick.project, run)} title={`Resume in ${pick.project.name}`}>
              <Play size={13} aria-hidden fill="currentColor" />
              Resume
              <CornerDownLeft size={12} aria-hidden className="opacity-80" />
            </PrimaryButton>
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-[#646A73]">Nothing to reopen yet. Sessions and chats will show here.</p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stat tiles

function Tile({ label, value, suffix, detail, graphic, children, testId }: { label: string; value: number; suffix?: string; detail: string; graphic: React.ReactNode; children?: React.ReactNode; testId: string }) {
  const shown = useCountUp(value);
  return (
    <Card className="hub-fade-up flex min-w-0 flex-col gap-1 p-4" data-testid={testId}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-meta font-medium text-muted">{label}</p>
          <p className="tnum mt-1 text-[32px] leading-none font-semibold">
            {shown}
            {suffix && <span className="text-[18px] font-semibold text-muted">{suffix}</span>}
          </p>
        </div>
        <div className="pt-1">{graphic}</div>
      </div>
      <p className="truncate text-meta text-muted">{detail}</p>
      {children}
    </Card>
  );
}

function StatTiles({ stats }: { stats: HomeStats }) {
  const pct = stats.toolkitTotal ? Math.round((stats.toolkitDone / stats.toolkitTotal) * 100) : 0;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4">
      <Tile
        testId="tile-running"
        label="Sessions running"
        value={stats.running}
        detail={stats.running ? `${runningLabel(stats)} across ${stats.runningProjects} project${stats.runningProjects === 1 ? '' : 's'}` : 'Nothing running'}
        graphic={
          <MiniBars
            label="Running sessions per project"
            bars={stats.perProject.filter((x) => x.running).map((x) => ({ key: x.slug, value: x.running, color: projectColor(x.slug).base, title: `${x.name}: ${runningLabel(x)}` }))}
          />
        }
      />
      <Tile
        testId="tile-active"
        label="Active projects"
        value={stats.active}
        suffix={` / ${stats.total}`}
        detail={stats.total - stats.active ? `${stats.total - stats.active} quiet for 14+ days` : 'None gone quiet'}
        graphic={
          <div className="flex max-w-24 flex-wrap justify-end gap-1" role="img" aria-label={`${stats.active} of ${stats.total} active`}>
            {Array.from({ length: stats.total }, (_, i) => (
              <span key={i} className={`size-2.5 rounded-full ${i < stats.active ? 'bg-accent' : 'border border-control bg-track'}`} />
            ))}
          </div>
        }
      />
      <Tile
        testId="tile-toolkit"
        label="Toolkit done"
        value={pct}
        suffix="%"
        detail={stats.toolkitTotal ? `${stats.toolkitDone} of ${stats.toolkitTotal} items across ${stats.toolkits.length} toolkit${stats.toolkits.length === 1 ? '' : 's'}` : 'No toolkit.yaml yet'}
        graphic={<Ring pct={pct} label={`${pct}% of toolkit items done`} color="var(--color-accent-2)" />}
      />
      <Tile
        testId="tile-needs"
        label="Needs a look"
        value={stats.needsCount}
        detail={stats.needsCount ? 'Uncommitted work and quiet projects' : 'All clear'}
        graphic={null}
      >
        {stats.needs.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-meta">
            {stats.needs.slice(0, 3).map((n) => (
              <li key={`${n.slug}-${n.why}`} className="flex min-w-0 items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: projectColor(n.slug).base }} aria-hidden />
                <Link to={`/p/${n.slug}`} className="min-w-0 truncate hover:underline">
                  {n.name}
                </Link>
                <span className={`ml-auto shrink-0 ${n.why.includes('uncommitted') ? 'text-warn' : 'text-muted'}`}>{n.why}</span>
              </li>
            ))}
            {stats.needs.length > 3 && <li className="text-tiny text-muted">+{stats.needs.length - 3} more</li>}
          </ul>
        )}
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side charts

function RunningCard({ stats }: { stats: HomeStats }) {
  const rows = stats.perProject.filter((x) => x.running > 0).sort((a, b) => b.running - a.running);
  return (
    <Card as="section" className="hub-fade-up p-4" data-testid="running-donut">
      <h2 className="mb-3 text-[15px] font-semibold">Running sessions</h2>
      <div className="flex items-center gap-4">
        <Donut
          size={124}
          thickness={16}
          label={rows.length ? rows.map((r) => `${r.name} ${r.running}`).join(', ') : 'No sessions running'}
          segments={rows.map((r) => ({ key: r.slug, label: r.name, value: r.running, color: projectColor(r.slug).base }))}
          center={
            <>
              <span className="tnum text-[24px] leading-none font-semibold">{stats.running}</span>
              <span className="text-tiny text-muted">running</span>
            </>
          }
        />
        <ul className="min-w-0 flex-1 space-y-1.5 text-meta">
          {rows.length === 0 && <li className="text-muted">Nothing running</li>}
          {rows.map((r) => (
            <li key={r.slug} className="flex min-w-0 items-center gap-2">
              <Swatch color={projectColor(r.slug).base} />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="tnum shrink-0 font-semibold">{r.running}</span>
              <span className="tnum w-9 shrink-0 text-right text-muted">{Math.round((r.running / stats.running) * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ToolkitCard({ stats }: { stats: HomeStats }) {
  const pct = stats.toolkitTotal ? Math.round((stats.toolkitDone / stats.toolkitTotal) * 100) : 0;
  return (
    <Card as="section" className="hub-fade-up p-4" data-testid="toolkit-gauge">
      <h2 className="mb-2 text-[15px] font-semibold">Toolkit</h2>
      {stats.toolkitTotal === 0 ? (
        <p className="text-meta text-muted">No project has a toolkit.yaml yet.</p>
      ) : (
        <>
          <div className="flex flex-col items-center">
            <HalfGauge pct={pct} width={180} label={`${pct}% of toolkit items done`} />
            <p className="tnum mt-2 text-[24px] leading-none font-semibold">{pct}%</p>
            <p className="text-meta text-muted">
              {stats.toolkitDone} of {stats.toolkitTotal} done
            </p>
          </div>
          <ul className="mt-3 space-y-2">
            {stats.toolkits.map((t) => {
              const c = projectColor(t.slug);
              const w = t.total ? (t.done / t.total) * 100 : 0;
              return (
                <li key={t.slug} className="text-meta">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{t.name}</span>
                    <span className="tnum shrink-0 text-muted">
                      {t.done}/{t.total}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-track">
                    <div className="hub-grow h-full rounded-pill" style={{ width: `${w}%`, background: c.base }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quiet projects as compact rows

function QuietList({ projects, activity }: { projects: ProjectDto[]; activity: Record<string, ProjectActivity> | undefined }) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: (slug: string) => archiveProject(slug, true),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
  return (
    <Card as="div" className="divide-y divide-line">
      <ul className="divide-y divide-line">
        {projects.map((p) => {
          const last = activity?.[p.slug]?.last;
          return (
            <li key={p.slug} className="flex items-center gap-3 px-4 py-2.5" data-testid="project-card" data-stale="true" data-status={p.sessions.length ? 'ended' : 'none'}>
              <ProjectChip slug={p.slug} name={p.name} size={28} />
              <Link to={`/p/${p.slug}`} className="min-w-0 shrink-0 truncate font-semibold hover:underline">
                {p.name}
              </Link>
              <span className="min-w-0 flex-1 truncate text-meta text-muted">{last ? `Last: ${describeEvent(last)}` : 'No activity yet'}</span>
              {last && <span className="shrink-0 font-mono text-tiny text-muted">{ago(last.at)}</span>}
              <button
                type="button"
                onClick={() => archive.mutate(p.slug)}
                disabled={archive.isPending}
                title="Hide this card; its history is kept"
                className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-control px-2 py-1 text-meta text-muted hover:bg-soft hover:text-ink"
              >
                <Archive size={13} aria-hidden /> Archive
              </button>
            </li>
          );
        })}
      </ul>
      {archive.error && <p className="px-4 py-2 text-meta text-red-600">{archive.error.message}</p>}
    </Card>
  );
}

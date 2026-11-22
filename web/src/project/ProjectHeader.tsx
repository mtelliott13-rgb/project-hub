// The project page's header card: chip, name, where it lives, status pills, last
// activity and actions on the left; the toolkit gauge on the right. When the
// toolkit's done count goes up while the page is open, the gauge moves, the
// Done number pops and a short confetti burst fires (no confetti under reduced motion).
import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fetchToolkit, toolkitOk, type ProjectActivity, type ProjectDto } from '../api.ts';
import { HalfGauge } from '../charts.tsx';
import { PROJECT_PALETTE, runningCounts, runningLabel } from '../colors.ts';
import { Card, PingDot, Pill, ProjectChip, shortenHome, useReducedMotion } from '../ui.tsx';
import { ProjectActions, ProjectMenu, type Run } from './parts.tsx';
import { LastActivity, StatusBadges } from './status.tsx';

export function ProjectHeader({ project: p, run, activity, onDeleted }: { project: ProjectDto; run: Run; activity?: ProjectActivity; onDeleted: () => void }) {
  const where = [...p.repos, ...p.folders].map(shortenHome);
  const counts = runningCounts(p.sessions);
  const uncommitted = p.repoStatus.reduce((n, r) => n + (r?.git?.uncommitted ?? 0), 0);
  const branches = [...new Set(p.repoStatus.map((r) => r?.git?.branch).filter((b): b is string => !!b))];
  return (
    <Card className="hub-fade-up flex flex-wrap gap-5 rounded-header p-5" data-testid="project-header">
      <div className="min-w-0 flex-[1_1_420px] space-y-3">
        <div className="flex items-start gap-4">
          <ProjectChip slug={p.slug} name={p.name} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="text-[27px] leading-tight font-bold break-words">{p.name}</h1>
            <p className="mt-1 font-mono text-tiny [overflow-wrap:anywhere] text-muted">
              {[...where, ...(p.github.length ? [`GitHub: ${p.github.join(', ')}`] : []), ...(p.keywords.length ? [`keywords: ${p.keywords.join(', ')}`] : [])].join(' · ') || 'No folders or repos yet'}
            </p>
          </div>
          <ProjectMenu project={p} onDeleted={onDeleted} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {counts.running > 0 && (
            <Pill tone={counts.idle === counts.running ? 'idle' : 'live'} data-badge="running">
              <PingDot size={7} idle={counts.idle === counts.running} />
              {runningLabel(counts)}
            </Pill>
          )}
          {uncommitted > 0 && (
            <Pill tone="warn" data-badge="uncommitted">
              {uncommitted} uncommitted
            </Pill>
          )}
          {branches.map((b) => (
            <Pill key={b} tone="neutral">
              <GitBranch size={11} aria-hidden />
              <span className="font-mono">{b}</span>
            </Pill>
          ))}
          <StatusBadges project={p} activity={activity} omit={['running', 'uncommitted']} />
        </div>
        <LastActivity last={activity ? activity.last : undefined} />
        <ProjectActions project={p} run={run} />
      </div>
      {p.toolkit && <ToolkitPanel project={p} />}
    </Card>
  );
}

const CONFETTI = PROJECT_PALETTE.map((c) => c.base);

function ToolkitPanel({ project: p }: { project: ProjectDto }) {
  const toolkit = useQuery({ queryKey: ['toolkit', p.slug], queryFn: () => fetchToolkit(p.slug) }).data;
  const reduced = useReducedMotion();
  const done = p.toolkit?.done ?? 0;
  const total = p.toolkit?.total ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const prev = useRef<number | null>(null);
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (prev.current !== null && done > prev.current) setBurst((b) => b + 1);
    prev.current = done;
  }, [done]);
  useEffect(() => {
    if (!burst) return;
    const t = setTimeout(() => setBurst(0), 1200);
    return () => clearTimeout(t);
  }, [burst]);

  const items = toolkitOk(toolkit) ? toolkit.items : [];
  const count = (s: string) => items.filter((i) => i.status === s).length;
  const rows = [
    { label: 'Done', n: count('done'), cls: 'bg-accent-2' },
    { label: 'In progress', n: count('in progress'), cls: 'bg-amber-500' },
    { label: 'To do', n: count('not started'), cls: 'bg-accent' },
    { label: 'Parked', n: count('parked'), cls: 'bg-control' },
  ];

  if (p.toolkit?.error)
    return (
      <div className="flex-[0_1_340px] rounded-card bg-soft p-4 text-meta text-warn" data-testid="header-toolkit">
        Toolkit: toolkit.yaml can't be read
      </div>
    );
  return (
    <div className="flex min-w-0 flex-[0_1_360px] flex-wrap items-center justify-center gap-4 rounded-card bg-soft p-4" data-testid="header-toolkit">
      <div className="relative flex flex-col items-center">
        <HalfGauge pct={pct} width={170} label={`Toolkit ${pct}% done`} />
        <p className="tnum mt-1 text-[22px] leading-none font-semibold">{pct}%</p>
        <p className="text-tiny text-muted">
          {done} of {total} done
        </p>
        {burst > 0 && !reduced && (
          <span aria-hidden className="pointer-events-none absolute top-[78px] left-1/2" key={burst}>
            {Array.from({ length: 22 }, (_, i) => {
              const angle = (Math.PI * (i / 21)) + Math.PI; // upward half
              const dist = 50 + ((i * 37) % 45);
              return (
                <span
                  key={i}
                  className="hub-confetti absolute block h-2 w-1.5 rounded-[1px]"
                  style={{ background: CONFETTI[i % CONFETTI.length], '--dx': `${Math.cos(angle) * dist}px`, '--dy': `${Math.sin(angle) * dist - 10}px`, '--rot': `${(i * 67) % 360}deg` } as CSSProperties}
                />
              );
            })}
          </span>
        )}
      </div>
      <ul className="min-w-[130px] space-y-1.5 text-meta">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${r.cls}`} aria-hidden />
            <span className="flex-1 text-muted">{r.label}</span>
            <span key={r.label === 'Done' ? `d${done}` : r.label} className={`tnum inline-block font-semibold ${r.label === 'Done' && burst ? 'hub-pop' : ''}`}>
              {toolkitOk(toolkit) ? r.n : '–'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

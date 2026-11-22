// The project page's charts row: Activity (two smooth areas over the last 10
// days) and What you did (the same window by event kind).
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchTimeline, type ProjectDto } from '../api.ts';
import { Donut, Swatch } from '../charts.tsx';
import { CHART } from '../colors.ts';
import { Card } from '../ui.tsx';
import { binDays, monotonePath, niceScale, type DayBin } from './chart-data.ts';

const DAYS = 10;
// The server caps a timeline at 1000 events; 10 days of one project fits well within that.
const LIMIT = 1000;

const SERIES = [
  { key: 'claude', label: 'Claude work', color: CHART.claude, what: 'sessions + chats' },
  { key: 'code', label: 'Code', color: CHART.code, what: 'commits + file saves' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];

export function useTenDays(slug: string): DayBin[] | undefined {
  const { data } = useQuery({ queryKey: ['activity', slug, 'chart'], queryFn: () => fetchTimeline(slug, LIMIT), placeholderData: keepPreviousData });
  return data ? binDays(data.events, DAYS) : undefined;
}

export function ChartsRow({ project }: { project: ProjectDto }) {
  const bins = useTenDays(project.slug);
  return (
    <div className="flex flex-wrap gap-5" data-testid="charts-row">
      <ActivityChart bins={bins} />
      <WhatYouDid bins={bins} />
    </div>
  );
}

const W = 600;
const H = 210;
// Side padding is at least half a day column, so the day buttons stay inside the chart.
const PAD = { l: 38, r: 34, t: 12, b: 26 };

function ActivityChart({ bins }: { bins: DayBin[] | undefined }) {
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());
  const [active, setActive] = useState<number | null>(null);
  const shown = SERIES.filter((s) => !hidden.has(s.key));
  const max = Math.max(0, ...(bins ?? []).flatMap((b) => shown.map((s) => b[s.key])));
  const { top, step } = niceScale(max);
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (innerW * i) / (DAYS - 1);
  const y = (v: number) => PAD.t + innerH - (innerH * v) / top;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const toggle = (k: SeriesKey) => {
    const next = new Set(hidden);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setHidden(next);
  };
  const a = active !== null && bins ? bins[active] : null;

  return (
    <Card as="section" className="hub-fade-up min-w-0 flex-[2_1_480px] p-4" data-testid="activity-chart">
      <div className="mb-1 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">Activity</h2>
          <p className="text-tiny text-muted">
            Last {DAYS} days. Commits are the last 10 per repo; file saves are grouped by hour and only count since the hub started.
          </p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Show or hide lines">
          {SERIES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={!hidden.has(s.key)}
              onClick={() => toggle(s.key)}
              title={`${hidden.has(s.key) ? 'Show' : 'Hide'} ${s.label} (${s.what})`}
              className={`flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-meta transition ${hidden.has(s.key) ? 'border-control text-muted line-through' : 'border-line bg-soft text-ink'}`}
            >
              <Swatch color={s.color} hollow={hidden.has(s.key)} />
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {!bins ? (
        <p className="py-16 text-center text-meta text-muted">Loading…</p>
      ) : (
        <div className="relative -mx-1 overflow-x-auto px-1">
          <div className="relative min-w-[420px]">
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Activity over the last ${DAYS} days: ${SERIES.map((s) => `${s.label} ${bins.reduce((n, b) => n + b[s.key], 0)}`).join(', ')}`}>
              <defs>
                {SERIES.map((s) => (
                  <linearGradient key={s.key} id={`area-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor={s.color} stopOpacity="0.22" />
                    <stop offset="1" stopColor={s.color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
                  <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-muted)" className="tnum">
                    {t}
                  </text>
                </g>
              ))}
              {bins.map((b, i) => (
                <text key={b.start} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fontWeight={b.today ? 700 : 400} fill={b.today ? 'var(--color-ink)' : 'var(--color-muted)'}>
                  {b.today ? 'Today' : b.label}
                </text>
              ))}
              {shown.map((s) => {
                const pts = bins.map((b, i) => [x(i), y(b[s.key])] as [number, number]);
                const line = monotonePath(pts);
                const area = `${line} L${x(DAYS - 1)},${y(0)} L${x(0)},${y(0)} Z`;
                return (
                  <g key={s.key}>
                    <path d={area} fill={`url(#area-${s.key})`} className="hub-fade-up" />
                    <path d={line} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1} className="hub-draw" />
                  </g>
                );
              })}
              {a && active !== null && (
                <g pointerEvents="none">
                  <line x1={x(active)} x2={x(active)} y1={PAD.t} y2={y(0)} stroke="var(--color-muted)" strokeOpacity={0.5} strokeDasharray="3 3" />
                  {shown.map((s) => (
                    <circle key={s.key} cx={x(active)} cy={y(a[s.key])} r={4} fill="var(--color-card)" stroke={s.color} strokeWidth={2} />
                  ))}
                </g>
              )}
            </svg>
            {/* One focusable button per day, over the chart, for hover and keyboard. */}
            <div className="absolute inset-0 flex" style={{ left: `${((PAD.l - innerW / (DAYS - 1) / 2) / W) * 100}%`, right: `${((PAD.r - innerW / (DAYS - 1) / 2) / W) * 100}%` }} onMouseLeave={() => setActive(null)}>
              {bins.map((b, i) => (
                <button
                  key={b.start}
                  type="button"
                  className="h-full flex-1 rounded-[6px] focus-visible:bg-accent/5"
                  aria-label={`${new Date(b.start).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}: ${b.claude} Claude work (${b.sessions} sessions, ${b.chats} chats), ${b.code} code (${b.commits} commits, ${b.files} file saves)`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  onKeyDown={(e) => {
                    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
                    if (to === null || to < 0 || to >= DAYS) return;
                    e.preventDefault();
                    (e.currentTarget.parentElement?.children[to] as HTMLButtonElement | undefined)?.focus();
                  }}
                />
              ))}
            </div>
            {a && active !== null && (
              <div
                role="status"
                className="pointer-events-none absolute top-2 z-10 w-44 rounded-btn border border-line bg-card p-2.5 text-meta shadow-lift"
                style={{ left: `clamp(0px, calc(${(x(active) / W) * 100}% + ${active > DAYS / 2 ? '-188px' : '12px'}), calc(100% - 176px))` }}
              >
                <p className="mb-1 font-semibold">{new Date(a.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                {SERIES.map((s) => (
                  <p key={s.key} className={`flex items-center gap-1.5 ${hidden.has(s.key) ? 'opacity-50' : ''}`}>
                    <Swatch color={s.color} />
                    <span className="flex-1">{s.label}</span>
                    <span className="tnum font-semibold">{a[s.key]}</span>
                  </p>
                ))}
                <p className="mt-1 text-tiny text-muted">
                  {a.sessions} sessions · {a.chats} chats · {a.commits} commits · {a.files} saves
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function WhatYouDid({ bins }: { bins: DayBin[] | undefined }) {
  const sum = (k: 'sessions' | 'chats' | 'commits' | 'files') => (bins ?? []).reduce((n, b) => n + b[k], 0);
  const segments = [
    { key: 'sessions', label: 'Sessions', value: sum('sessions'), color: CHART.sessions },
    { key: 'chats', label: 'Chats', value: sum('chats'), color: CHART.chats },
    { key: 'commits', label: 'Commits', value: sum('commits'), color: CHART.commits },
    { key: 'files', label: 'File saves', value: sum('files'), color: CHART.files },
  ];
  const total = segments.reduce((n, s) => n + s.value, 0);
  return (
    <Card as="section" className="hub-fade-up min-w-0 flex-[1_1_280px] p-4" data-testid="what-you-did">
      <h2 className="text-[15px] font-semibold">What you did</h2>
      <p className="mb-3 text-tiny text-muted">Last {DAYS} days, by kind</p>
      <div className="flex flex-wrap items-center gap-4">
        <Donut
          size={128}
          thickness={16}
          label={`${total} events: ${segments.map((s) => `${s.label} ${s.value}`).join(', ')}`}
          segments={segments}
          center={
            <>
              <span className="tnum text-[24px] leading-none font-semibold">{total}</span>
              <span className="text-tiny text-muted">events</span>
            </>
          }
        />
        <ul className="grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-2 text-meta">
          {segments.map((s) => (
            <li key={s.key} className="flex min-w-0 items-center gap-1.5">
              <Swatch color={s.color} />
              <span className="min-w-0 truncate text-muted">{s.label}</span>
              <span className="tnum ml-auto font-semibold">{s.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

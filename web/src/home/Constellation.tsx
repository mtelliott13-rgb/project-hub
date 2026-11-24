// The project constellation: every active project on one of three orbits around
// a centre showing live sessions. Running projects sit on the inner ring,
// recent ones on the middle, quiet (stale) ones on the outer, evenly spaced and
// balanced across rings (ringAngles). Hover or focus highlights one; click opens it.
import { useState } from 'react';
import { describeEvent } from '../../../src/server/activity.ts';
import type { ProjectActivity, ProjectDto } from '../api.ts';
import { initials, isIdle, projectColor, runningCounts, runningLabel, ringAngles } from '../colors.ts';
import { navigate } from '../router.tsx';
import { ago, Card } from '../ui.tsx';
import { daysSince, longAgo, tierOf, type Tier } from './model.ts';

const W = 700;
const H = 400;
const CX = W / 2;
const CY = H / 2;
const RINGS: Record<Tier, { rx: number; ry: number }> = {
  running: { rx: 120, ry: 74 },
  recent: { rx: 200, ry: 120 },
  quiet: { rx: 278, ry: 164 },
};
const TIERS: Tier[] = ['running', 'recent', 'quiet'];

type Node = { p: ProjectDto; tier: Tier; angle: number; x: number; y: number; cos: number; sin: number; sub: string };

function subLine(p: ProjectDto, tier: Tier, a: ProjectActivity | undefined): string {
  if (tier === 'running') return runningLabel(runningCounts(p.sessions));
  if (!a?.last) return 'No activity yet';
  if (tier === 'quiet') return `${daysSince(a.last.at)} days quiet`;
  return longAgo(a.last.at);
}

const LABEL_H = 28;
const labelWidth = (n: Node) => Math.max(Math.min(n.p.name.length, 22) * 6.9, n.sub.length * 5.8) + 4;

/**
 * Where a node's label sits: on the side away from the centre. A label that
 * would run off the left or right edge moves above or below its dot instead,
 * pulled back inside the chart.
 */
function labelSpot(n: Node) {
  const r = n.tier === 'running' ? 7 : 5.5;
  const w = labelWidth(n);
  let side: 'start' | 'end' | 'middle' = n.cos > 0.25 ? 'start' : n.cos < -0.25 ? 'end' : 'middle';
  if ((side === 'start' && n.x + r + 6 + w > W - 4) || (side === 'end' && n.x - r - 6 - w < 4)) side = 'middle';
  let x = side === 'start' ? n.x + r + 6 : side === 'end' ? n.x - r - 6 : n.x;
  if (side === 'middle') x = Math.min(W - 4 - w / 2, Math.max(4 + w / 2, x));
  const y = side === 'middle' ? n.y + (n.sin > 0 ? r + 13 : -(r + 18)) : n.y - 1;
  return { side, x, y, w };
}

/** The label's rough box (name plus sub-line), for keeping labels apart. */
function labelBox(n: Node) {
  const { side, x, y, w } = labelSpot(n);
  const x0 = side === 'start' ? x : side === 'end' ? x - w : x - w / 2;
  return { x0, x1: x0 + w, y0: y - 11, y1: y - 11 + LABEL_H };
}

function place(p: ProjectDto, tier: Tier, angle: number, sub: string): Node {
  const rad = (angle * Math.PI) / 180;
  const { rx, ry } = RINGS[tier];
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { p, tier, angle, x: CX + rx * cos, y: CY + ry * sin, cos, sin, sub };
}

function layout(projects: ProjectDto[], activity: Record<string, ProjectActivity> | undefined): Node[] {
  let nodes: Node[] = [];
  const rings = TIERS.map((tier) => projects.filter((p) => tierOf(p, activity) === tier));
  const angles = ringAngles(rings.map((ring) => ring.map((p) => p.slug)));
  TIERS.forEach((tier, t) => rings[t].forEach((p, i) => nodes.push(place(p, tier, angles[t][i], subLine(p, tier, activity?.[p.slug])))));
  // Labels on different rings can still collide: nudge the outer one along its
  // ring until it's clear (a few passes; deterministic, so nothing jumps around).
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = labelBox(nodes[i]);
        const b = labelBox(nodes[j]);
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
          const k = TIERS.indexOf(nodes[j].tier) >= TIERS.indexOf(nodes[i].tier) ? j : i;
          const n = nodes[k];
          nodes = nodes.map((m, idx) => (idx === k ? place(n.p, n.tier, n.angle + 9, n.sub) : m));
          moved = true;
        }
      }
    if (!moved) break;
  }
  return nodes;
}

export function Constellation({ projects, activity }: { projects: ProjectDto[]; activity: Record<string, ProjectActivity> | undefined }) {
  const [hover, setHover] = useState<string | null>(null);
  const nodes = layout(projects, activity);
  const live = projects.reduce((n, p) => n + p.sessions.filter((s) => s.state === 'running').length, 0);
  // More live sessions, faster pulse (3 s down to 1.2 s).
  const glowSpeed = `${Math.max(1.2, 3 - live * 0.3)}s`;
  const focused = nodes.find((n) => n.p.slug === hover);

  return (
    <Card as="section" className="hub-fade-up flex min-w-0 flex-[2_1_560px] flex-col p-4" data-testid="constellation">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-semibold">Project constellation</h2>
        <span className="flex-1" />
        <ul className="flex flex-wrap items-center gap-3 text-meta text-muted" aria-label="Legend">
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-accent ring-[1.5px] ring-live-dot ring-offset-1 ring-offset-card" aria-hidden /> Running
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-accent" aria-hidden /> Recent
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full border border-dashed border-muted" aria-hidden /> Quiet
          </li>
          <li className="text-tiny">closer = more recent</li>
        </ul>
      </div>
      <div className="-mx-1 flex flex-1 items-center overflow-x-auto px-1">
        <div className="relative w-full min-w-[600px]">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="group" aria-label="Projects by how recently they were active">
            <defs>
              <radialGradient id="orb" cx="40%" cy="35%" r="70%">
                <stop offset="0" stopColor="#7C93F0" />
                <stop offset="0.6" stopColor="#3B5BDB" />
                <stop offset="1" stopColor="#2847B8" />
              </radialGradient>
              <radialGradient id="orb-glow">
                <stop offset="0" stopColor="#3B5BDB" stopOpacity="0.35" />
                <stop offset="1" stopColor="#3B5BDB" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="orb-ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#3B5BDB" />
                <stop offset="0.5" stopColor="#2AA79B" />
                <stop offset="1" stopColor="#2AA79B" stopOpacity="0" />
              </linearGradient>
            </defs>

            {TIERS.map((t) => (
              <ellipse key={t} cx={CX} cy={CY} rx={RINGS[t].rx} ry={RINGS[t].ry} fill="none" stroke="var(--color-line)" strokeWidth={1.2} strokeDasharray={t === 'quiet' ? '3 5' : undefined} />
            ))}

            {/* Lines to the centre, under the nodes. */}
            {nodes.map((n) => {
              const c = projectColor(n.p.slug).base;
              const dim = hover && hover !== n.p.slug ? 0.35 : 1;
              const hot = hover === n.p.slug;
              return (
                <line
                  key={`l-${n.p.slug}`}
                  x1={CX}
                  y1={CY}
                  x2={n.x}
                  y2={n.y}
                  stroke={n.tier === 'quiet' ? 'var(--color-muted)' : c}
                  strokeWidth={hot ? 2.2 : n.tier === 'running' ? 1.6 : 1}
                  strokeOpacity={(n.tier === 'running' ? 0.75 : n.tier === 'recent' ? 0.3 : 0.35) * dim + (hot ? 0.25 : 0)}
                  strokeDasharray={n.tier === 'quiet' ? '3 4' : undefined}
                  className={n.tier === 'running' ? 'hub-flow' : undefined}
                  style={{ transition: 'stroke-opacity 0.2s' }}
                />
              );
            })}

            {/* The centre orb. */}
            <circle cx={CX} cy={CY} r={58} fill="url(#orb-glow)" className="hub-glow" style={{ ['--glow-speed' as string]: glowSpeed }} />
            <circle cx={CX} cy={CY} r={40} fill="none" stroke="url(#orb-ring)" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="160 92" className="hub-spin" />
            <circle cx={CX} cy={CY} r={32} fill="url(#orb)" />
            <text x={CX} y={CY + 2} textAnchor="middle" fill="#fff" fontSize={22} fontWeight={700} className="tnum">
              {live}
            </text>
            <text x={CX} y={CY + 15} textAnchor="middle" fill="#fff" fillOpacity={0.85} fontSize={8.5} fontWeight={600} letterSpacing={0.6}>
              LIVE
            </text>

            {nodes.map((n) => {
              const c = projectColor(n.p.slug);
              const dim = hover && hover !== n.p.slug ? 0.35 : 1;
              const r = n.tier === 'running' ? 7 : 5.5;
              const label = labelSpot(n);
              // All its running sessions idle: no ping, like the cards' status dot.
              const allIdle = n.tier === 'running' && n.p.sessions.filter((x) => x.state === 'running').every((x) => isIdle(x));
              return (
                <a
                  key={n.p.slug}
                  href={`/p/${n.p.slug}`}
                  aria-label={`${n.p.name}: ${n.sub}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                    e.preventDefault();
                    navigate(`/p/${n.p.slug}`);
                  }}
                  onMouseEnter={() => setHover(n.p.slug)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(n.p.slug)}
                  onBlur={() => setHover(null)}
                  className="cursor-pointer outline-none [&:focus-visible_.ring]:opacity-100"
                  style={{ opacity: dim, transition: 'opacity 0.2s' }}
                  data-tier={n.tier}
                >
                  <circle cx={n.x} cy={n.y} r={r + 7} fill="none" stroke="var(--color-accent)" strokeWidth={2} className="ring opacity-0" />
                  <circle cx={n.x} cy={n.y} r={22} fill="transparent" />
                  {n.tier === 'running' && !allIdle && <circle cx={n.x} cy={n.y} r={r} fill={c.base} className="hub-ping" opacity={0.5} />}
                  {n.tier === 'quiet' ? (
                    <circle cx={n.x} cy={n.y} r={r} fill="var(--color-card)" stroke={c.base} strokeWidth={1.6} strokeDasharray="2.5 2" />
                  ) : (
                    <circle cx={n.x} cy={n.y} r={r} fill={c.base} stroke="var(--color-card)" strokeWidth={2} />
                  )}
                  {n.tier === 'running' && <circle cx={n.x} cy={n.y} r={r + 2.5} fill="none" stroke="var(--color-live-dot)" strokeWidth={1.5} data-running-ring />}
                  <text x={label.x} y={label.y} textAnchor={label.side} fontSize={12} fontWeight={600} fill="var(--color-ink)">
                    {n.p.name.length > 22 ? `${n.p.name.slice(0, 21)}…` : n.p.name}
                  </text>
                  <text x={label.x} y={label.y + 13} textAnchor={label.side} fontSize={10.5} fill="var(--color-muted)">
                    {n.sub}
                  </text>
                </a>
              );
            })}
          </svg>
          {focused && <HoverCard node={focused} activity={activity?.[focused.p.slug]} />}
          {projects.length === 0 && <p className="absolute inset-x-0 bottom-4 text-center text-meta text-muted">No active projects yet.</p>}
        </div>
      </div>
    </Card>
  );
}

function HoverCard({ node: n, activity }: { node: Node; activity: ProjectActivity | undefined }) {
  const c = projectColor(n.p.slug);
  const left = (n.x / W) * 100;
  const top = (n.y / H) * 100;
  const below = n.y < H / 2;
  const status = n.tier === 'running' ? n.sub : n.tier === 'quiet' ? `Quiet · ${n.sub}` : 'Nothing running';
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-56 rounded-btn border border-line bg-card p-2.5 text-meta shadow-lift"
      style={{
        left: `clamp(0px, calc(${left}% - 112px), calc(100% - 224px))`,
        top: below ? `calc(${top}% + 18px)` : undefined,
        bottom: below ? undefined : `calc(${100 - top}% + 18px)`,
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-flex size-5 items-center justify-center rounded-[6px] text-[9px] font-bold" style={{ background: `${c.base}21`, color: c.deep }} aria-hidden>
          {initials(n.p.name)}
        </span>
        <span className="truncate font-semibold">{n.p.name}</span>
      </div>
      <p className={n.tier === 'running' ? 'text-live' : 'text-muted'}>{status}</p>
      {activity?.last && (
        <p className="mt-0.5 truncate text-muted">
          Last: {describeEvent(activity.last)} · <span className="font-mono text-tiny">{ago(activity.last.at)}</span>
        </p>
      )}
    </div>
  );
}

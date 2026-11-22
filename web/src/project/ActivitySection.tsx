// Activity (SPEC.md, Phase 8): one timeline of the project's sessions, chats,
// commits, CI, saved files and links, newest first and grouped by day. Built
// from what the hub already has, so commits are the last 10 per repo and files
// only what the watcher has seen since the hub started.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeEvent } from '../../../src/server/activity.ts';
import { fetchTimeline, type ActivityEvent } from '../api.ts';
import { Action, Pill, TextButton } from '../ui.tsx';
import { isIdle, sessionTag, tint } from '../colors.ts';
import { eventColor, eventIcon } from './status.tsx';
import type { SectionProps } from './sections.tsx';

const PAGE = 30;

const dayLabel = (d: Date) => {
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: days < 7 ? 'long' : undefined, month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function ActivitySection({ project, run }: SectionProps) {
  const [limit, setLimit] = useState(PAGE);
  const { data, error } = useQuery({
    queryKey: ['activity', project.slug, limit],
    queryFn: () => fetchTimeline(project.slug, limit),
    placeholderData: keepPreviousData,
  });
  const replay = useReplay(data?.events.length ?? 0);
  if (error) return <p className="text-[13px] text-red-600">{error.message}</p>;
  if (!data) return <p className="text-[13px] text-muted">Loading…</p>;
  if (data.events.length === 0) return <p className="text-[13px] text-muted">Nothing yet. Sessions, chats, commits, saved files and links will show here.</p>;

  const days: { label: string; events: { e: ActivityEvent; n: number }[] }[] = [];
  data.events.forEach((e, n) => {
    const label = dayLabel(new Date(e.at));
    if (days.at(-1)?.label !== label) days.push({ label, events: [] });
    days.at(-1)!.events.push({ e, n });
  });
  // Replay walks oldest to newest; events arrive newest first.
  const lit = replay.step === null ? null : data.events.length - 1 - replay.step;
  const litEvent = lit === null ? null : data.events[lit];

  return (
    <div className="space-y-4" data-testid="timeline">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={replay.toggle}
          aria-pressed={replay.step !== null}
          className="inline-flex items-center gap-1.5 rounded-[9px] border border-control bg-card px-2.5 py-1 text-meta font-medium hover:border-accent/40 hover:bg-soft"
        >
          {replay.step === null ? <Play size={13} aria-hidden /> : <Square size={12} aria-hidden fill="currentColor" />}
          {replay.step === null ? 'Replay these days' : 'Stop'}
        </button>
        <p className="min-w-0 truncate font-mono text-tiny text-muted" aria-live="polite" data-testid="replay-caption">
          {litEvent ? `${dayLabel(new Date(litEvent.at))} · ${time(new Date(litEvent.at))}` : ''}
        </p>
      </div>
      {days.map((d) => (
        <div key={d.label}>
          <h3 className="mb-1.5 text-meta font-semibold text-muted">{d.label}</h3>
          <ol className="relative">
            <span aria-hidden className="absolute top-3 bottom-3 left-[74px] w-px bg-line" />
            {d.events.map(({ e, n }) => (
              <Row key={`${e.kind}-${e.at}-${n}`} e={e} project={project} run={run} lit={lit === n} dim={lit !== null && n < lit} />
            ))}
          </ol>
        </div>
      ))}
      {data.total > data.events.length && <TextButton onClick={() => setLimit(limit + PAGE)}>Show older ({data.total - data.events.length} more)</TextButton>}
    </div>
  );
}

/** Steps through `count` events, one every 0.7 s, then stops. */
function useReplay(count: number) {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    if (step === null) return;
    if (step >= count) {
      const t = setTimeout(() => setStep(null), 1200);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep(step + 1), 700);
    return () => clearTimeout(t);
  }, [step, count]);
  return { step: step === null ? null : Math.min(step, count - 1), toggle: () => setStep(step === null ? 0 : null) };
}

function Row({ e, project, run, lit, dim }: { e: ActivityEvent; lit?: boolean; dim?: boolean } & SectionProps) {
  const { Icon, cls } = eventIcon(e);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (lit) ref.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [lit]);
  const when = new Date(e.at);
  const text = describeEvent(e);
  const external = (url: string | null, children: string) =>
    url && /^https?:\/\//.test(url) ? (
      <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
        {children}
      </a>
    ) : (
      children
    );
  let body: ReactNode = text;
  let action: ReactNode = null;
  switch (e.kind) {
    case 'session':
      // A running session quiet for over a day is idle (Claude Code never reported it ended).
      if (e.state === 'running' && isIdle({ state: e.state, lastActiveAt: e.at }))
        body = (
          <>
            {text}{' '}
            <Pill tone="idle" data-testid="session-tag">
              {sessionTag({ state: e.state, lastActiveAt: e.at })}
            </Pill>
          </>
        );
      if (e.reopenable)
        action = (
          <Action small title="Resume in Terminal" onClick={() => run({ kind: 'session', sessionId: e.sessionId })}>
            Resume
          </Action>
        );
      break;
    case 'chat':
      action = (
        <Action small title="Open in the Claude app" onClick={() => run({ kind: 'chat', chatId: e.chatId })}>
          Open
        </Action>
      );
      break;
    case 'commit':
      body = (
        <>
          {external(e.url, `commit ${e.short}`)} <span className="text-muted">{e.title}</span>
        </>
      );
      break;
    case 'ci':
      body = (
        <>
          {external(e.url, text)} {e.workflow !== 'CI' && <span className="text-muted">{e.workflow}</span>}
        </>
      );
      break;
    case 'files':
      body = (
        <>
          {e.count === 1 ? 'edited' : text}{' '}
          {/* A span, not a <button>: buttons can't be cut short with "…" mid-line. */}
          <span
            role="button"
            tabIndex={0}
            className={`cursor-pointer hover:underline ${e.count === 1 ? '' : 'font-mono text-xs text-muted'}`}
            title="Open the newest in VS Code"
            onClick={() => run({ kind: 'file', slug: project.slug, path: e.path })}
            onKeyDown={(k) => k.key === 'Enter' && run({ kind: 'file', slug: project.slug, path: e.path })}
          >
            {e.names.join(', ')}
            {e.count > e.names.length ? ` +${e.count - e.names.length}` : ''}
          </span>
        </>
      );
      break;
    case 'link':
      body = external(e.url, text);
      break;
  }
  return (
    <li
      ref={ref}
      className={`relative flex items-center gap-2.5 rounded-[9px] px-1 py-1 text-[13px] transition-[background-color,opacity] duration-300 ${lit ? 'bg-accent/10' : ''} ${dim ? 'opacity-45' : ''}`}
      data-kind={e.kind}
      data-lit={lit || undefined}
    >
      <span className="w-12 shrink-0 font-mono text-tiny whitespace-nowrap text-muted tabular-nums" title={when.toLocaleString()}>
        {time(when)}
      </span>
      <span className="relative z-[1] inline-flex size-6 shrink-0 items-center justify-center rounded-full ring-2 ring-card" style={{ background: tint(eventColor(e), 0.16) }}>
        <Icon size={13} className={cls} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{body}</span>
      {action}
    </li>
  );
}

// Activity (SPEC.md, Phase 8): one timeline of the project's sessions, chats,
// commits, CI, saved files and links, newest first and grouped by day. Built
// from what the hub already has, so commits are the last 10 per repo and files
// only what the watcher has seen since the hub started.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { describeEvent } from '../../../src/server/activity.ts';
import { fetchTimeline, type ActivityEvent } from '../api.ts';
import { Action, TextButton } from '../ui.tsx';
import { eventIcon } from './status.tsx';
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
  if (error) return <p className="text-sm text-red-600">{error.message}</p>;
  if (!data) return <p className="text-sm text-stone-500">Loading…</p>;
  if (data.events.length === 0) return <p className="text-sm text-stone-500">Nothing yet. Sessions, chats, commits, saved files and links will show here.</p>;

  const days: { label: string; events: ActivityEvent[] }[] = [];
  for (const e of data.events) {
    const label = dayLabel(new Date(e.at));
    if (days.at(-1)?.label !== label) days.push({ label, events: [] });
    days.at(-1)!.events.push(e);
  }

  return (
    <div className="space-y-3" data-testid="timeline">
      {days.map((d) => (
        <div key={d.label}>
          <h3 className="mb-1 text-xs font-medium text-stone-500">{d.label}</h3>
          <ol className="space-y-0.5">
            {d.events.map((e, i) => (
              <Row key={`${e.kind}-${e.at}-${i}`} e={e} project={project} run={run} />
            ))}
          </ol>
        </div>
      ))}
      {data.total > data.events.length && <TextButton onClick={() => setLimit(limit + PAGE)}>Show older ({data.total - data.events.length} more)</TextButton>}
    </div>
  );
}

function Row({ e, project, run }: { e: ActivityEvent } & SectionProps) {
  const { Icon, cls } = eventIcon(e);
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
          {external(e.url, `commit ${e.short}`)} <span className="text-stone-600 dark:text-stone-400">{e.title}</span>
        </>
      );
      break;
    case 'ci':
      body = (
        <>
          {external(e.url, text)} {e.workflow !== 'CI' && <span className="text-stone-500">{e.workflow}</span>}
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
            className={`cursor-pointer hover:underline ${e.count === 1 ? '' : 'font-mono text-xs text-stone-500'}`}
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
    <li className="flex items-center gap-2 py-0.5 text-sm" data-kind={e.kind}>
      <span className="w-16 shrink-0 text-xs whitespace-nowrap text-stone-500 tabular-nums" title={when.toLocaleString()}>
        {time(when)}
      </span>
      <Icon size={14} className={`shrink-0 ${cls}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{body}</span>
      {action}
    </li>
  );
}

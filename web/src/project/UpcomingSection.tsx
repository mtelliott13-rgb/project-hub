// Upcoming (project page): this project's calendar events (today through 14
// days out) and open tasks. Collapsed by default; its summary reads
// "Next: Fri 3:00 PM · 2 open tasks".
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { fetchCalendar, fetchTasks, updateTask } from '../api.ts';
import { openTasks, upcomingSummary, whenText } from '../today/model.ts';
import type { SectionProps } from './sections.tsx';

const useUpcoming = (slug: string) => ({
  calendar: useQuery({ queryKey: ['calendar', slug], queryFn: () => fetchCalendar(slug) }),
  tasks: useQuery({ queryKey: ['tasks', slug], queryFn: () => fetchTasks(slug) }),
});

export function UpcomingSummary({ slug }: { slug: string }) {
  const { calendar, tasks } = useUpcoming(slug);
  if (!calendar.data || !tasks.data) return null;
  return <>{upcomingSummary(calendar.data.events, tasks.data, new Date())}</>;
}

export function UpcomingSection({ project }: SectionProps) {
  const queryClient = useQueryClient();
  const { calendar, tasks } = useUpcoming(project.slug);
  const done = useMutation({ mutationFn: (id: number) => updateTask(id, { done: true }), onSettled: () => void queryClient.invalidateQueries() });
  const now = new Date();
  const events = (calendar.data?.events ?? []).filter((e) => Date.parse(e.endsAt) > now.getTime());
  const open = openTasks(tasks.data ?? []);
  const g = calendar.data?.google;
  return (
    <div className="space-y-3 text-[13px]" data-testid="upcoming">
      <div>
        <h3 className="mb-1 text-tiny font-semibold tracking-[0.08em] text-muted uppercase">Events</h3>
        {events.length === 0 ? (
          <p className="text-muted">{g && g.state === 'not-set-up' && !g.sample ? 'Google Calendar isn\'t connected.' : 'Nothing in the next two weeks.'}</p>
        ) : (
          <ul className="space-y-1">
            {events.map((e) => (
              <li key={e.id} className="flex items-baseline gap-3">
                <span className="w-32 shrink-0 font-mono text-[12px] text-muted">{whenText(e, now)}</span>
                {e.htmlLink ? (
                  <a href={e.htmlLink} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink hover:underline">
                    {e.title} <ExternalLink size={11} aria-label="(opens Google Calendar)" className="inline text-muted" />
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-ink">{e.title}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-tiny font-semibold tracking-[0.08em] text-muted uppercase">Open tasks</h3>
        {open.length === 0 ? (
          <p className="text-muted">None.</p>
        ) : (
          <ul className="space-y-1">
            {open.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <input id={`up-task-${t.id}`} type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={false} onChange={() => done.mutate(t.id)} />
                <label htmlFor={`up-task-${t.id}`} className="text-ink">
                  {t.title}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

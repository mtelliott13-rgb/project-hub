// The Agenda card: today's events with a "now" line, the next 7 days folded by
// day, and the Google connection's state. "Needs reconnect" is shown here with
// a one-click Reconnect, because Google apps in Testing expire sign-ins every 7
// days and this is the card you look at every day.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, ChevronRight, ExternalLink, FlaskConical, RefreshCw, Repeat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { connectConnector, syncGoogle, type CalendarAnswer, type EventDto, type ProjectDto } from '../api.ts';
import { Link } from '../router.tsx';
import { ago, Card, IconButton, Pill, PrimaryButton, ProjectChip } from '../ui.tsx';
import { agenda, clock, isNow, isPast, nowIndex, timeRange } from './model.ts';

/** The current time, ticking every 30 seconds, so the "now" line moves. */
export function useNow(every = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

export function AgendaCard({ data, projects, error }: { data: CalendarAnswer | undefined; projects: ProjectDto[]; error: Error | null }) {
  const now = useNow();
  const names = new Map(projects.map((p) => [p.slug, p.name]));
  const g = data?.google;
  const showEvents = !!g && (g.state !== 'not-set-up' || g.sample || data!.events.length > 0);
  const { today, next } = agenda(data?.events ?? [], now);
  const line = nowIndex(today, now);

  return (
    <Card as="section" className="flex min-w-0 flex-col p-5 lg:col-span-2" data-testid="agenda" aria-labelledby="agenda-h">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays size={16} aria-hidden className="text-muted" />
        <h2 id="agenda-h" className="text-[15px] font-semibold text-ink">
          Agenda
        </h2>
        {g && <SyncState g={g} />}
      </div>

      <ReturnNote g={g} />
      {error && <p className="mt-3 text-[13px] text-red-700 dark:text-red-300">{error.message}</p>}
      {g?.state === 'needs-reconnect' && <ReconnectBox g={g} />}
      {g?.state === 'error' && g.error && (
        <p className="mt-3 flex items-start gap-1.5 text-[13px] text-warn" data-testid="agenda-error">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            Last sync failed: {g.error}
            {g.lastSyncAt && <> Showing events from {ago(g.lastSyncAt)}.</>}
          </span>
        </p>
      )}

      {g && !showEvents && (
        <div className="mt-4 flex flex-col items-start gap-3 rounded-card border border-dashed border-control p-5" data-testid="agenda-connect">
          <p className="text-[13px] text-muted">Connect your Google Calendar to see today's events here and add reminders from the quick-add bar.</p>
          <Link
            to="/settings#connections"
            className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-white shadow-glow transition hover:brightness-110"
            data-testid="connect-google"
          >
            <CalendarDays size={14} aria-hidden /> Connect Google Calendar
          </Link>
        </div>
      )}

      {showEvents && (
        <>
          <ol className="mt-3 space-y-1" aria-label="Today's events" data-testid="agenda-today">
            {today.length === 0 && <li className="py-2 text-[13px] text-muted">Nothing on the calendar today.</li>}
            {today.map((e, i) => (
              <li key={e.id} className="contents">
                {line === i && <NowLine now={now} />}
                <EventRow e={e} names={names} now={now} />
              </li>
            ))}
            {line === today.length && today.length > 0 && (
              <li className="contents">
                <NowLine now={now} />
              </li>
            )}
          </ol>

          <h3 className="mt-5 mb-1 text-tiny font-semibold tracking-[0.08em] text-muted uppercase">Next 7 days</h3>
          <ul className="divide-y divide-line" data-testid="agenda-week">
            {next.map((d) => (
              <DayGroupRow key={d.key} label={d.label} events={d.events} names={names} now={now} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function SyncState({ g }: { g: CalendarAnswer['google'] }) {
  const queryClient = useQueryClient();
  const sync = useMutation({ mutationFn: syncGoogle, onSettled: () => void queryClient.invalidateQueries() });
  if (g.sample)
    return (
      <Pill tone="accent" className="ml-auto" data-testid="agenda-sample">
        <FlaskConical size={11} aria-hidden /> Sample data
      </Pill>
    );
  if (g.state === 'needs-reconnect')
    return (
      <Pill tone="warn" className="ml-auto" data-testid="agenda-state" data-state="needs-reconnect">
        <AlertTriangle size={11} aria-hidden /> Needs reconnect
      </Pill>
    );
  if (g.state !== 'connected' && g.state !== 'error') return null;
  return (
    <span className="ml-auto flex items-center gap-2">
      {g.lastSyncAt && <span className="text-[12px] text-muted">Synced {ago(g.lastSyncAt)}</span>}
      <IconButton label={sync.isPending ? 'Syncing Google Calendar' : 'Sync Google Calendar now'} onClick={() => sync.mutate()} disabled={sync.isPending}>
        <RefreshCw size={14} aria-hidden className={sync.isPending ? 'hub-busy' : ''} />
      </IconButton>
    </span>
  );
}

function ReconnectBox({ g }: { g: CalendarAnswer['google'] }) {
  const [problem, setProblem] = useState<string | null>(null);
  const reconnect = useMutation({
    mutationFn: () => connectConnector('google', '/today'),
    onSuccess: (r) => {
      if (r.redirect) location.assign(r.redirect);
    },
    onError: (e: Error) => setProblem(e.message),
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-card bg-warn-bg p-3" role="status" data-testid="agenda-reconnect">
      <p className="min-w-0 flex-[1_1_240px] text-[13px] text-ink">
        <AlertTriangle size={14} aria-hidden className="mr-1 inline text-warn" />
        <span className="font-semibold">Google Calendar needs reconnecting.</span> {g.error ?? 'Google no longer accepts the saved sign-in.'}{' '}
        {g.lastSyncAt && <span className="text-muted">Showing events from {ago(g.lastSyncAt)}.</span>}
      </p>
      {g.canConnect ? (
        <PrimaryButton onClick={() => reconnect.mutate()} disabled={reconnect.isPending} testId="agenda-reconnect-button">
          <RefreshCw size={13} aria-hidden /> {reconnect.isPending ? 'Opening Google…' : 'Reconnect'}
        </PrimaryButton>
      ) : (
        <Link to="/settings#connections" className="text-[13px] font-medium text-accent hover:underline">
          Check Settings → Connections
        </Link>
      )}
      {problem && (
        <p role="alert" className="w-full text-[13px] text-red-700 dark:text-red-300">
          {problem}
        </p>
      )}
    </div>
  );
}

/** After Reconnect, Google sends you back to /today?connected=google&ok=1|0: say how it went once, then tidy the URL. */
function ReturnNote({ g }: { g: CalendarAnswer['google'] | undefined }) {
  const [result, setResult] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('connected') !== 'google') return;
    setResult(q.get('ok') === '1' ? 'ok' : 'failed');
    history.replaceState(null, '', location.pathname);
  }, []);
  if (!result) return null;
  return (
    <p role="status" className={`mt-3 text-[13px] ${result === 'ok' ? 'text-live' : 'text-warn'}`} data-testid="agenda-return">
      {result === 'ok' ? 'Google Calendar is connected again.' : `Reconnecting didn't finish${g?.error ? `: ${g.error}` : '.'}`}
    </p>
  );
}

function NowLine({ now }: { now: Date }) {
  return (
    <div className="flex items-center gap-2 py-0.5" data-testid="now-line" aria-label={`Now, ${clock(now)}`} role="separator">
      <span className="w-[104px] shrink-0 text-right font-mono text-[11px] font-semibold text-accent">Now {clock(now)}</span>
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
      <span aria-hidden className="h-px flex-1 bg-accent" />
    </div>
  );
}

function EventRow({ e, names, now, compact }: { e: EventDto; names: Map<string, string>; now: Date; compact?: boolean }) {
  const past = isPast(e, now);
  const happening = isNow(e, now);
  const project = e.project ? names.get(e.project) : undefined;
  const body = (
    <>
      <span className={`w-[104px] shrink-0 text-right font-mono text-[12px] ${past ? 'text-muted' : 'text-ink'}`}>{e.allDay ? 'All day' : compact ? clock(e.startsAt) : timeRange(e).split(' – ')[0]}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${past ? 'text-muted' : 'font-medium text-ink'}`}>
          {e.title}
          {past && <span className="sr-only"> (ended)</span>}
        </span>
        {!compact && !e.allDay && <span className="block font-mono text-[11px] text-muted">{timeRange(e)}</span>}
      </span>
      {happening && (
        <Pill tone="live" data-testid="event-now">
          Now
        </Pill>
      )}
      {e.recurring && <Repeat size={12} aria-label="Repeats" className="shrink-0 text-muted" />}
      {e.project && project && (
        <span className="flex shrink-0 items-center gap-1.5" title={project}>
          <ProjectChip slug={e.project} name={project} size={20} />
          <span className="hidden text-[12px] text-muted sm:inline">{project}</span>
          <span className="sr-only sm:hidden">{project}</span>
        </span>
      )}
      {e.htmlLink && <ExternalLink size={12} aria-hidden className="shrink-0 text-muted opacity-0 transition-opacity group-hover/event:opacity-100" />}
    </>
  );
  const cls = 'group/event flex items-center gap-3 rounded-btn px-1 py-1.5';
  return e.htmlLink ? (
    <a href={e.htmlLink} target="_blank" rel="noreferrer" className={`${cls} hover:bg-soft`} data-testid="agenda-event" aria-label={`${e.title}, ${timeRange(e)}${project ? `, ${project}` : ''} (opens Google Calendar)`}>
      {body}
    </a>
  ) : (
    <div className={cls} data-testid="agenda-event">
      {body}
    </div>
  );
}

function DayGroupRow({ label, events, names, now }: { label: string; events: EventDto[]; names: Map<string, string>; now: Date }) {
  const [open, setOpen] = useState(false);
  const id = `day-${label.replace(/\W+/g, '-')}`;
  return (
    <li data-testid="agenda-day">
      <button type="button" className="flex w-full items-center gap-2 rounded-btn px-1 py-2 text-left hover:bg-soft" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} disabled={events.length === 0}>
        <ChevronRight size={14} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''} ${events.length === 0 ? 'opacity-0' : ''}`} />
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-muted">{events.length === 0 ? 'Nothing scheduled' : `${events.length} event${events.length === 1 ? '' : 's'}`}</span>
        {!open && events[0] && (
          <span className="ml-auto hidden min-w-0 truncate text-[12px] text-muted sm:block">
            {events[0].allDay ? '' : `${clock(events[0].startsAt)} `}
            {events[0].title}
          </span>
        )}
      </button>
      {open && (
        <ol id={id} className="pb-2">
          {events.map((e) => (
            <li key={e.id}>
              <EventRow e={e} names={names} now={now} compact />
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

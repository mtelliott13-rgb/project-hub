import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Project, Session } from '../../src/server/db/schema.ts';
import { launch, type LaunchBody } from './launch.ts';

// Dates arrive as ISO strings over JSON.
type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
type SessionDto = Jsonified<Session>;
type ProjectDto = Jsonified<Project> & { sessions: SessionDto[] };

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error(`GET /api/projects failed: ${res.status}`);
  return res.json();
}

/** Refetches whenever the server says something changed. */
function useLiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('change', () => queryClient.invalidateQueries({ queryKey: ['projects'] }));
    return () => source.close();
  }, [queryClient]);
}

const shortenHome = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

type LaunchStatus = { ok: boolean; text: string } | null;

/** Runs a launch and reports the exact command, or why it was refused. */
function useLauncher() {
  const [status, setStatus] = useState<LaunchStatus>(null);
  const run = (body: LaunchBody) =>
    launch(body).then(
      (command) => setStatus({ ok: true, text: `Ran: ${command}` }),
      (err: Error) => setStatus({ ok: false, text: err.message }),
    );
  return { status, run };
}

export function App() {
  useLiveUpdates();
  const { data, error, isPending } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const { status, run } = useLauncher();

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Project Hub</h1>
        {status && (
          <p
            data-testid="launch-status"
            className={`mb-4 rounded-md px-3 py-2 font-mono text-xs break-all ${status.ok ? 'bg-stone-100 text-stone-700 dark:bg-stone-900 dark:text-stone-300' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'}`}
          >
            {status.text}
          </p>
        )}
        {isPending && <p className="text-stone-500">Loading…</p>}
        {error && <p className="text-red-600">{error.message}</p>}
        {data?.length === 0 && (
          <p className="text-stone-500">No projects yet. Add some to ~/.project-hub/projects.yaml and restart the hub.</p>
        )}
        <ul className="grid gap-4 sm:grid-cols-2">
          {data?.map((p) => <ProjectCard key={p.slug} project={p} run={run} />)}
        </ul>
      </main>
    </div>
  );
}

const PREVIEW = 5;

type Run = (body: LaunchBody) => Promise<void>;

/**
 * Resume reopens whatever was touched last. Sessions are the only thing the hub
 * knows about until Phase 7 adds chats; then the newer of the two wins.
 */
function resume(p: ProjectDto, run: Run) {
  const latest = p.sessions[0];
  if (!latest) return;
  if (latest.state === 'running' && !confirm('That session is still running. Open a second copy of it anyway?')) return;
  void run({ kind: 'session', sessionId: latest.id });
}

function ProjectCard({ project: p, run }: { project: ProjectDto; run: Run }) {
  const [showAll, setShowAll] = useState(false);
  const running = p.sessions.some((s) => s.state === 'running');
  const latest = p.sessions[0];
  const shown = showAll ? p.sessions : p.sessions.slice(0, PREVIEW);

  return (
    <li
      data-testid="project-card"
      data-status={running ? 'running' : latest ? 'ended' : 'none'}
      className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">{p.name}</h2>
          <p className="font-mono text-xs text-stone-500">{p.slug}</p>
        </div>
        {running ? (
          <Badge className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">running</Badge>
        ) : latest ? (
          <Badge className="bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">ended</Badge>
        ) : null}
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        {p.repos.length > 0 && <Row label="Repo" values={p.repos.map(shortenHome)} />}
        {p.folders.length > 0 && <Row label="Folders" values={p.folders.map(shortenHome)} />}
        {p.github.length > 0 && <Row label="GitHub" values={p.github} />}
        {p.keywords.length > 0 && <Row label="Keywords" values={p.keywords} />}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Action primary disabled={!latest} title={latest ? 'Reopen the latest session in Terminal' : 'No sessions yet'} onClick={() => resume(p, run)}>
          Resume
        </Action>
        {p.repos.length > 0 && (
          <Action title="Start Claude Code in this repo" onClick={() => run({ kind: 'new-session', slug: p.slug })}>
            New session here
          </Action>
        )}
        {p.repos.length + p.folders.length > 0 && (
          <Action title="Open in VS Code" onClick={() => run({ kind: 'editor', slug: p.slug })}>
            Open repo
          </Action>
        )}
        {p.claudeProject && (
          <Action title="Start a chat inside this Claude Project" onClick={() => run({ kind: 'claude-project', slug: p.slug })}>
            New chat in project
          </Action>
        )}
      </div>
      <h3 className="mt-4 text-xs font-medium tracking-wide text-stone-500 uppercase">
        Sessions ({p.sessions.length})
      </h3>
      {p.sessions.length === 0 ? (
        <p className="mt-1 text-sm text-stone-500">None yet</p>
      ) : (
        <ul className="mt-1 divide-y divide-stone-100 text-sm dark:divide-stone-800">
          {shown.map((s) => (
            <li key={s.id} data-testid="session-row" data-state={s.state} className="flex items-center gap-2 py-1.5">
              <span
                title={s.state}
                className={`size-2 shrink-0 rounded-full ${s.state === 'running' ? 'bg-green-500' : 'bg-stone-300 dark:bg-stone-600'}`}
              />
              <span className="min-w-0 flex-1 truncate">{s.title ?? <span className="text-stone-500">Untitled session</span>}</span>
              {s.gitBranch && <span className="shrink-0 font-mono text-xs text-stone-500">{s.gitBranch}</span>}
              <span className="w-16 shrink-0 text-right text-xs text-stone-500">{ago(s.lastActiveAt)}</span>
              <span className="flex shrink-0 gap-1">
                <Action small title="Resume in Terminal" onClick={() => run({ kind: 'session', sessionId: s.id })}>
                  Terminal
                </Action>
                <Action small title="Open in the Claude desktop app" onClick={() => run({ kind: 'desktop', sessionId: s.id })}>
                  Desktop
                </Action>
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.sessions.length > PREVIEW && (
        <button className="mt-1 text-xs text-stone-500 underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${p.sessions.length}`}
        </button>
      )}
    </li>
  );
}

function Action({
  children,
  onClick,
  title,
  primary,
  small,
  disabled,
}: {
  children: string;
  onClick: () => void;
  title: string;
  primary?: boolean;
  small?: boolean;
  disabled?: boolean;
}) {
  const look = primary
    ? 'bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300'
    : 'border border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-40 ${look} ${small ? 'px-1.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'}`}
    >
      {children}
    </button>
  );
}

function Badge({ className, children }: { className: string; children: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function Row({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-stone-500">{label}</dt>
      <dd className="font-mono break-all">{values.join(', ')}</dd>
    </div>
  );
}

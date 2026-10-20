import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchFileError, fetchProjects } from './api.ts';
import { IdeasPage } from './IdeasPage.tsx';
import { launch, type LaunchBody } from './launch.ts';
import { ProjectCard, type Run } from './ProjectCard.tsx';
import { ProjectForm } from './ProjectForm.tsx';
import { ProjectPage } from './ProjectPage.tsx';
import { Link, route, usePath } from './router.tsx';
import { Action } from './ui.tsx';

// Text you edit (notes, drafts) loads once and is never refetched underneath you.
const EDITED_TEXT = new Set(['notes', 'draft']);

/** Refetches whenever the server says something changed. */
function useLiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('change', () => {
      void queryClient.invalidateQueries({ predicate: (q) => !EDITED_TEXT.has(String(q.queryKey[0])) });
    });
    return () => source.close();
  }, [queryClient]);
}

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
  const fileError = useQuery({ queryKey: ['projects-file'], queryFn: fetchFileError }).data?.error;
  const { status, run } = useLauncher();
  const [adding, setAdding] = useState(false);
  const here = route(usePath());
  useEffect(() => {
    document.title = here.page === 'ideas' ? 'Ideas · Project Hub' : 'Project Hub';
  }, [here.page]);

  const navClass = (active: boolean) => `text-sm ${active ? 'font-medium' : 'text-stone-500 hover:text-stone-900 dark:hover:text-stone-100'}`;
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <main className="mx-auto max-w-6xl px-4 py-6">
        <nav className="mb-6 flex items-center gap-4 border-b border-stone-200 pb-3 dark:border-stone-800">
          <Link to="/" className="text-lg font-semibold">
            Project Hub
          </Link>
          <Link to="/" className={navClass(here.page === 'home')}>
            Projects
          </Link>
          <Link to="/ideas" className={navClass(here.page === 'ideas')}>
            Ideas
          </Link>
          <span className="flex-1" />
          <Action primary onClick={() => setAdding(true)}>
            Add project
          </Action>
        </nav>
        {fileError && (
          <p data-testid="file-error" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            ~/.project-hub/projects.yaml has an error, so the hub is showing the last good version until it's fixed:{' '}
            <span className="font-mono text-xs whitespace-pre-wrap">{fileError}</span>
          </p>
        )}
        {status && (
          <p
            data-testid="launch-status"
            className={`mb-4 rounded-md px-3 py-2 font-mono text-xs break-all ${status.ok ? 'bg-stone-100 text-stone-700 dark:bg-stone-900 dark:text-stone-300' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'}`}
          >
            {status.text}
          </p>
        )}
        {here.page === 'home' && <Home run={run} />}
        {here.page === 'project' && <ProjectPage slug={here.slug} run={run} />}
        {here.page === 'ideas' && <IdeasPage />}
        {adding && <ProjectForm onClose={() => setAdding(false)} />}
      </main>
    </div>
  );
}

function Home({ run }: { run: Run }) {
  const { data, error, isPending } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [showArchived, setShowArchived] = useState(false);
  const active = data?.filter((p) => !p.archived) ?? [];
  const archived = data?.filter((p) => p.archived) ?? [];
  return (
    <>
      {isPending && <p className="text-stone-500">Loading…</p>}
      {error && <p className="text-red-600">{error.message}</p>}
      {data && active.length === 0 && <p className="text-stone-500">No projects yet. Use Add project to make one.</p>}
      <ul className="grid gap-4 sm:grid-cols-2">
        {active.map((p) => (
          <ProjectCard key={p.slug} project={p} run={run} />
        ))}
      </ul>
      {archived.length > 0 && (
        <section className="mt-8">
          <button type="button" className="text-sm text-stone-500 hover:underline" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && (
            <ul className="mt-3 grid gap-4 sm:grid-cols-2">
              {archived.map((p) => (
                <ProjectCard key={p.slug} project={p} run={run} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

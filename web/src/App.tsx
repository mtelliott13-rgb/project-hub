import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchFileError, fetchInbox } from './api.ts';
import { InboxPage } from './InboxPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { IdeasPage } from './IdeasPage.tsx';
import { launch, type LaunchBody } from './launch.ts';
import { ProjectForm } from './ProjectForm.tsx';
import { ProjectPage } from './ProjectPage.tsx';
import { Link, route, usePath } from './router.tsx';
import { PrimaryButton } from './ui.tsx';
import { HomePage } from './home/HomePage.tsx';
import { Plus, User } from 'lucide-react';
import { Switcher, SwitcherButton } from './Switcher.tsx';

// Text you edit (notes, drafts) loads once and is never refetched underneath you.
const EDITED_TEXT = new Set(['notes', 'draft']);
// What a saved file can change: the recent-files lists, and last activity and timelines.
const FILE_QUERIES = new Set(['files', 'activity']);

/** Refetches whenever the server says something changed. */
function useLiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events');
    // 'files' changes only the recent-files lists and activity; anything else may change everything.
    source.addEventListener('change', (e) => {
      const topic = (e as MessageEvent<string>).data;
      void queryClient.invalidateQueries({
        predicate: (q) => (topic === 'files' ? FILE_QUERIES.has(String(q.queryKey[0])) : !EDITED_TEXT.has(String(q.queryKey[0]))),
      });
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
  const [finding, setFinding] = useState(false);
  const here = route(usePath());
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: fetchInbox }).data;
  const waiting = inbox ? inbox.links.length + inbox.sessions.length + inbox.chats.length : 0;
  useEffect(() => {
    const names = { ideas: 'Ideas', inbox: 'Inbox', settings: 'Settings' } as Record<string, string>;
    document.title = names[here.page] ? `${names[here.page]} · Project Hub` : 'Project Hub';
  }, [here.page]);

  const tabs = [
    { to: '/', label: 'Projects', on: here.page === 'home' || here.page === 'project' },
    { to: '/inbox', label: 'Inbox', on: here.page === 'inbox', count: waiting },
    { to: '/ideas', label: 'Ideas', on: here.page === 'ideas' },
    { to: '/settings', label: 'Settings', on: here.page === 'settings' },
  ];
  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <nav className="mx-auto flex h-[60px] max-w-[1240px] items-center gap-3 px-4 sm:gap-5 sm:px-6" aria-label="Main">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-[15px] font-bold">
            <span aria-hidden className="inline-block size-6 rounded-[7px] bg-gradient-to-br from-accent to-accent-2 shadow-glow" />
            <span className="hidden sm:inline">Project Hub</span>
          </Link>
          <div className="flex h-full items-stretch gap-1 overflow-x-auto sm:gap-2">
            {tabs.map((t) => (
              <Link
                key={t.to}
                to={t.to}
                aria-current={t.on ? 'page' : undefined}
                className={`flex items-center gap-1.5 border-b-2 px-1.5 text-[13px] font-medium whitespace-nowrap transition-colors ${t.on ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
              >
                {t.label}
                {!!t.count && (
                  <span data-testid="inbox-count" className="tnum rounded-pill bg-accent/10 px-1.5 text-tiny font-semibold text-accent">
                    <span className="sr-only">(</span>
                    {t.count}
                    <span className="sr-only">)</span>
                  </span>
                )}
              </Link>
            ))}
          </div>
          <span className="flex-1" />
          <SwitcherButton onClick={() => setFinding(true)} />
          <PrimaryButton onClick={() => setAdding(true)} title="Add a project to projects.yaml">
            <Plus size={14} aria-hidden />
            <span className="hidden sm:inline">New project</span>
            <span className="sr-only sm:hidden">New project</span>
          </PrimaryButton>
          <span aria-hidden className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#E9EEFF] to-[#FFEFD8] text-muted sm:inline-flex">
            <User size={15} />
          </span>
        </nav>
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6">
        {fileError && (
          <p data-testid="file-error" className="mb-4 rounded-btn bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950 dark:text-red-300">
            ~/.project-hub/projects.yaml has an error, so the hub is showing the last good version until it's fixed:{' '}
            <span className="font-mono text-xs whitespace-pre-wrap">{fileError}</span>
          </p>
        )}
        {status && (
          <p
            data-testid="launch-status"
            className={`mb-4 rounded-btn px-3 py-2 font-mono text-xs break-all ${status.ok ? 'border border-line bg-card text-muted' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'}`}
          >
            {status.text}
          </p>
        )}
        {here.page === 'home' && <HomePage run={run} />}
        {here.page === 'project' && <ProjectPage slug={here.slug} run={run} />}
        {here.page === 'ideas' && <IdeasPage />}
        {here.page === 'inbox' && <InboxPage run={run} />}
        {here.page === 'settings' && <SettingsPage />}
        {adding && <ProjectForm onClose={() => setAdding(false)} />}
        <Switcher run={run} open={finding} setOpen={setFinding} onNewProject={() => setAdding(true)} />
      </main>
    </div>
  );
}

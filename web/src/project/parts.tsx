// Pieces shared by the project card and the project page.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { archiveProject, type ProjectDto, type SessionDto } from '../api.ts';
import type { LaunchBody } from '../launch.ts';
import { ConfirmDelete, ProjectForm } from '../ProjectForm.tsx';
import { latestReopenable, listed } from '../resume.ts';
import { navigate } from '../router.tsx';
import { Action, ago, Badge, TextButton } from '../ui.tsx';

export type Run = (body: LaunchBody) => Promise<void>;


/**
 * Resume reopens whatever was touched last that can be reopened. Sessions are
 * the only thing the hub knows about until Phase 7 adds chats; then the newer
 * of the two wins.
 */
function resume(p: ProjectDto, run: Run) {
  const latest = latestReopenable(p.sessions);
  if (!latest) return;
  if (latest.state === 'running' && !confirm('That session is still running. Open a second copy of it anyway?')) return;
  void run({ kind: 'session', sessionId: latest.id });
}

export function StatusBadge({ project: p }: { project: ProjectDto }) {
  if (p.archived) return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">archived</Badge>;
  if (p.sessions.some((s) => s.state === 'running'))
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">running</Badge>;
  if (p.sessions.length) return <Badge className="bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">ended</Badge>;
  return null;
}

/** Resume, New session here, Open in VS Code, New chat in project. */
export function ProjectActions({ project: p, run }: { project: ProjectDto; run: Run }) {
  const latest = latestReopenable(p.sessions);
  const why = p.sessions.length ? 'None of its sessions can be reopened' : 'No sessions yet';
  return (
    <div className="flex flex-wrap gap-2">
      <Action
        primary
        disabled={!latest}
        title={latest ? `Reopen "${latest.title ?? 'Untitled session'}" in Terminal` : why}
        onClick={() => resume(p, run)}
      >
        Resume
      </Action>
      {p.repos.length > 0 && (
        <Action title="Start Claude Code in this repo" onClick={() => run({ kind: 'new-session', slug: p.slug })}>
          New session here
        </Action>
      )}
      {p.repos.length + p.folders.length > 0 && (
        <Action title="Open in VS Code" onClick={() => run({ kind: 'editor', slug: p.slug })}>
          Open in VS Code
        </Action>
      )}
      {p.claudeProject && (
        <Action title="Start a chat inside this Claude Project" onClick={() => run({ kind: 'claude-project', slug: p.slug })}>
          New chat in project
        </Action>
      )}
    </div>
  );
}

/** Edit and Archive, or Unarchive and Delete for an archived project. */
export function ProjectMenu({ project: p, onDeleted }: { project: ProjectDto; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const archive = useMutation({
    mutationFn: (archived: boolean) => archiveProject(p.slug, archived),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
  return (
    <>
      <div className="flex gap-3">
        {p.archived ? (
          <>
            <TextButton onClick={() => archive.mutate(false)} title="Show this card again">
              Unarchive
            </TextButton>
            <TextButton onClick={() => setDeleting(true)} title="Remove the hub's record of this project">
              Delete…
            </TextButton>
          </>
        ) : (
          <>
            <TextButton onClick={() => setEditing(true)}>Edit</TextButton>
            <TextButton onClick={() => archive.mutate(true)} title="Hide this card; its history is kept">
              Archive
            </TextButton>
          </>
        )}
      </div>
      {archive.error && <p className="text-xs text-red-600">{archive.error.message}</p>}
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} onDeleted={onDeleted} />}
      {deleting && (
        <ConfirmDelete
          project={p}
          onCancel={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            void queryClient.invalidateQueries({ queryKey: ['projects'] });
            onDeleted?.();
          }}
        />
      )}
    </>
  );
}

/**
 * Sessions, newest first. Those that can be reopened (and any running now) are
 * listed with Terminal and Desktop buttons; the rest fold into one line that
 * says why. `preview` shows that many until expanded.
 */
export function SessionList({ sessions: all, run, preview }: { sessions: SessionDto[]; run: Run; preview?: number }) {
  const [showAll, setShowAll] = useState(false);
  const [showGone, setShowGone] = useState(false);
  const sessions = listed(all);
  const gone = all.filter((s) => !sessions.includes(s));
  const shown = preview && !showAll ? sessions.slice(0, preview) : sessions;
  if (all.length === 0) return <p className="mt-1 text-sm text-stone-500">None yet</p>;
  return (
    <>
      {sessions.length === 0 && <p className="mt-1 text-sm text-stone-500">None that can be reopened.</p>}
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
            {s.resumeProblem === null ? (
              <span className="flex shrink-0 gap-1">
                <Action small title="Resume in Terminal" onClick={() => run({ kind: 'session', sessionId: s.id })}>
                  Terminal
                </Action>
                <Action small title="Open in the Claude desktop app" onClick={() => run({ kind: 'desktop', sessionId: s.id })}>
                  Desktop
                </Action>
              </span>
            ) : (
              <span className="shrink-0 text-xs text-stone-500" title={s.resumeProblem}>
                not saved yet
              </span>
            )}
          </li>
        ))}
      </ul>
      {preview !== undefined && sessions.length > preview && (
        <button type="button" className="mt-1 mr-3 text-xs text-stone-500 underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${sessions.length}`}
        </button>
      )}
      {gone.length > 0 && (
        <>
          <button type="button" data-testid="unreopenable-toggle" className="mt-1 text-xs text-stone-500 underline" onClick={() => setShowGone(!showGone)}>
            {showGone ? 'Hide' : `${gone.length} more can't be reopened`}
          </button>
          {showGone && (
            <ul className="mt-1 space-y-0.5 text-xs text-stone-500">
              {gone.map((s) => (
                <li key={s.id} data-testid="unreopenable-row" className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">{s.title ?? 'Untitled session'}</span>
                  <span className="shrink-0">{ago(s.lastActiveAt)}</span>
                  <span className="shrink-0 truncate" title={s.resumeProblem ?? ''}>
                    {s.resumeProblem?.startsWith('Its folder') ? 'folder gone' : 'no saved conversation'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

export const openProject = (slug: string) => navigate(`/p/${slug}`);

export const listedSessions = (p: ProjectDto) => listed(p.sessions);

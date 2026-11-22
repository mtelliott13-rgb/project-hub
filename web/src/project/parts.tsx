// Pieces shared by the project card and the project page.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Code2, MessageSquarePlus, MoreHorizontal, Play, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { archiveProject, type ProjectDto, type SessionDto } from '../api.ts';
import type { LaunchBody } from '../launch.ts';
import { ConfirmDelete, ProjectForm } from '../ProjectForm.tsx';
import { listed, resumeTarget } from '../resume.ts';
import { navigate } from '../router.tsx';
import { Action, ago, IconButton, PrimaryButton, SoftButton } from '../ui.tsx';

export type Run = (body: LaunchBody) => Promise<void>;


/** Resume reopens whatever was touched last: the newest reopenable session, or the newest chat. */
export function resume(p: ProjectDto, run: Run) {
  const target = resumeTarget(p.sessions, p.chats);
  if (!target) return;
  if (target.kind === 'chat') return void run({ kind: 'chat', chatId: target.chat.id });
  if (target.session.state === 'running' && !confirm('That session is still running. Open a second copy of it anyway?')) return;
  void run({ kind: 'session', sessionId: target.session.id });
}

/** What Resume would open, as a tooltip. */
export function resumeTitle(p: ProjectDto): string {
  const target = resumeTarget(p.sessions, p.chats);
  if (!target) return p.sessions.length ? 'None of its sessions can be reopened' : 'No sessions or chats yet';
  return target.kind === 'chat'
    ? `Reopen the chat "${target.chat.title ?? 'Untitled chat'}" in the Claude app`
    : `Reopen "${target.session.title ?? 'Untitled session'}" in Terminal`;
}

/**
 * Resume, New session here, Open in VS Code, New chat in project. Each extra
 * action shows only when it applies. `card` uses icon buttons and an "R" hint
 * on hover; the page spells the actions out.
 */
export function ProjectActions({ project: p, run, variant = 'page' }: { project: ProjectDto; run: Run; variant?: 'card' | 'page' }) {
  const target = resumeTarget(p.sessions, p.chats);
  const extras = [
    p.repos.length > 0 && { key: 'new', label: 'New session', title: 'Start Claude Code in this repo', Icon: SquareTerminal, go: () => run({ kind: 'new-session', slug: p.slug }) },
    p.repos.length + p.folders.length > 0 && { key: 'code', label: 'VS Code', title: 'Open in VS Code', Icon: Code2, go: () => run({ kind: 'editor', slug: p.slug }) },
    p.claudeProject && { key: 'chat', label: 'New chat', title: 'Start a chat inside this Claude Project', Icon: MessageSquarePlus, go: () => run({ kind: 'claude-project', slug: p.slug }) },
  ].filter((x): x is Exclude<typeof x, false | null | undefined | ''> => !!x);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PrimaryButton disabled={!target} title={resumeTitle(p)} onClick={() => resume(p, run)} hint={variant === 'card' ? 'R' : undefined} hintOnHover testId="resume">
        <Play size={13} aria-hidden fill="currentColor" />
        Resume
      </PrimaryButton>
      {extras.map(({ key, label, title, Icon, go }) =>
        variant === 'card' ? (
          <IconButton key={key} label={title} onClick={go}>
            <Icon size={15} aria-hidden />
          </IconButton>
        ) : (
          <SoftButton key={key} title={title} onClick={go}>
            <Icon size={15} aria-hidden className="text-muted" />
            {label}
          </SoftButton>
        ),
      )}
    </div>
  );
}

/** The ⋯ menu: Edit and Archive, or Unarchive and Delete for an archived project. */
export function ProjectMenu({ project: p, onDeleted }: { project: ProjectDto; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const archive = useMutation({
    mutationFn: (archived: boolean) => archiveProject(p.slug, archived),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const away = (e: globalThis.MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('mousedown', away);
    return () => removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      box.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };
  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  const items: { label: string; title?: string; go: () => void; danger?: boolean }[] = p.archived
    ? [
        { label: 'Unarchive', title: 'Show this card again', go: () => archive.mutate(false) },
        { label: 'Delete…', title: "Remove the hub's record of this project", go: () => setDeleting(true), danger: true },
      ]
    : [
        { label: 'Edit', go: () => setEditing(true) },
        { label: 'Archive', title: 'Hide this card; its history is kept', go: () => archive.mutate(true) },
      ];
  return (
    <>
      <div ref={box} className="relative" onKeyDown={onKey}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`More actions for ${p.name}`}
          title="More actions"
          onClick={() => setOpen(!open)}
          className="inline-flex size-8 items-center justify-center rounded-[9px] text-muted transition hover:bg-soft hover:text-ink"
        >
          <MoreHorizontal size={18} aria-hidden />
        </button>
        {open && (
          <div role="menu" aria-label={`${p.name} actions`} className="hub-fade-up absolute top-9 right-0 z-20 min-w-36 rounded-btn border border-line bg-card p-1 shadow-lift">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                title={it.title}
                onClick={pick(it.go)}
                className={`block w-full rounded-[7px] px-2.5 py-1.5 text-left text-[13px] hover:bg-soft focus-visible:bg-soft ${it.danger ? 'text-red-700 dark:text-red-400' : 'text-ink'}`}
              >
                {it.label}
              </button>
            ))}
          </div>
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

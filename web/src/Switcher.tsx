// The Cmd-K switcher (SPEC.md, Phase 8): ⌘K anywhere opens a search over the
// projects (running first, then newest activity, as on the home page) and the
// hub's actions and pages. Enter opens the page; ⌘Enter on a project runs its Resume.
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Inbox, LayoutGrid, Lightbulb, Play, Plus, Search, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { sortProjects } from '../../src/server/activity.ts';
import { fetchProjects } from './api.ts';
import { runningCounts, runningLabel } from './colors.ts';
import { newestPickUp } from './home/model.ts';
import { openProject, resume, type Run } from './project/parts.tsx';
import { useActivity } from './project/status.tsx';
import { navigate } from './router.tsx';
import { ago, Kbd, PingDot, ProjectChip } from './ui.tsx';

const PAGES: { to: string; label: string; Icon: LucideIcon }[] = [
  { to: '/', label: 'Go to Projects', Icon: LayoutGrid },
  { to: '/inbox', label: 'Go to Inbox', Icon: Inbox },
  { to: '/ideas', label: 'Go to Ideas', Icon: Lightbulb },
  { to: '/settings', label: 'Go to Settings', Icon: Settings },
];

const PROJECT = 'project:';

/** The top bar's search field, which opens the switcher and shows the shortcut. */
export function SwitcherButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Find a project (⌘K)"
      className="flex h-9 shrink-0 items-center gap-2 rounded-btn border border-control bg-soft-2 px-2.5 text-[13px] text-muted transition hover:border-accent/40 sm:w-56"
    >
      <Search size={15} aria-hidden />
      <span className="hidden flex-1 text-left sm:inline">Find a project</span>
      <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
    </button>
  );
}

const itemClass = 'flex cursor-pointer items-center gap-3 rounded-btn px-2.5 py-2 text-[13px] data-[selected=true]:bg-accent/10 data-[selected=true]:text-ink';
const groupClass = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-tiny [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted [&_[cmdk-group-heading]]:uppercase';

export function Switcher({ run, open, setOpen, onNewProject }: { run: Run; open: boolean; setOpen: (open: boolean) => void; onNewProject?: () => void }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects }).data ?? [];
  const activity = useActivity();
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  const sorted = sortProjects(projects, activity, (p) => p.slug);
  const ordered = [...sorted.filter((p) => !p.archived), ...sorted.filter((p) => p.archived)];
  const pick = newestPickUp(sorted.filter((p) => !p.archived));
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  // ⌘Enter on a project: Resume it instead of opening its page.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !selected.startsWith(PROJECT)) return;
    const p = projects.find((x) => x.slug === selected.slice(PROJECT.length));
    if (!p) return;
    e.preventDefault();
    setOpen(false);
    resume(p, run);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Find a project or page"
      value={selected}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
      overlayClassName="fixed inset-0 z-40 bg-[#0f1216]/45"
      contentClassName="hub-fade-up fixed inset-x-4 top-[12vh] z-50 mx-auto max-w-[620px] overflow-hidden rounded-header border border-line bg-card text-ink shadow-lift"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search size={18} className="text-muted" aria-hidden />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Find a project or action…"
          className="w-full bg-transparent py-4 text-[16px] outline-none placeholder:text-muted"
        />
        <Kbd>esc</Kbd>
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        <Command.Empty className="px-2 py-8 text-center text-muted">Nothing matches.</Command.Empty>
        <Command.Group heading="Projects" className={groupClass}>
          {ordered.map((p) => {
            const last = activity?.[p.slug]?.last;
            const counts = runningCounts(p.sessions);
            return (
              <Command.Item
                key={p.slug}
                value={`${PROJECT}${p.slug}`}
                keywords={[p.name, ...p.keywords]}
                onSelect={() => {
                  setOpen(false);
                  openProject(p.slug);
                }}
                className={`group ${itemClass}`}
              >
                <ProjectChip slug={p.slug} name={p.name} size={26} />
                <span className={`min-w-0 truncate font-medium ${p.archived ? 'text-muted' : ''}`}>{p.name}</span>
                {p.archived && <span className="text-tiny text-muted">archived</span>}
                {counts.running > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-tiny font-medium text-live">
                    <PingDot size={6} idle={counts.idle === counts.running} />
                    {runningLabel(counts)}
                  </span>
                )}
                <span className="flex-1" />
                {last && <span className="shrink-0 font-mono text-tiny text-muted">{ago(last.at)}</span>}
                <span className="hidden shrink-0 gap-1 group-data-[selected=true]:flex">
                  <Kbd>↵</Kbd>
                  <Kbd>⌘↵ Resume</Kbd>
                </span>
              </Command.Item>
            );
          })}
        </Command.Group>
        <Command.Group heading="Actions" className={groupClass}>
          {pick && (
            <Command.Item
              value="action:resume-latest"
              keywords={['resume', 'pick up', pick.project.name]}
              onSelect={() => {
                setOpen(false);
                resume(pick.project, run);
              }}
              className={itemClass}
            >
              <span className="inline-flex size-[26px] items-center justify-center rounded-[8px] bg-accent/10 text-accent">
                <Play size={13} aria-hidden fill="currentColor" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                Resume where you left off <span className="text-muted">· {pick.project.name}</span>
              </span>
            </Command.Item>
          )}
          {onNewProject && (
            <Command.Item
              value="action:new-project"
              keywords={['add', 'new', 'project']}
              onSelect={() => {
                setOpen(false);
                onNewProject();
              }}
              className={itemClass}
            >
              <span className="inline-flex size-[26px] items-center justify-center rounded-[8px] bg-soft text-muted">
                <Plus size={14} aria-hidden />
              </span>
              New project
            </Command.Item>
          )}
          {PAGES.map(({ to, label, Icon }) => (
            <Command.Item key={to} value={`page:${label}`} onSelect={() => go(to)} className={itemClass}>
              <span className="inline-flex size-[26px] items-center justify-center rounded-[8px] bg-soft text-muted">
                <Icon size={14} aria-hidden />
              </span>
              {label}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex flex-wrap gap-4 border-t border-line bg-soft-2 px-4 py-2.5 text-tiny text-muted">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌘↵</Kbd> Resume
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </Command.Dialog>
  );
}

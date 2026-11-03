// The Cmd-K switcher (SPEC.md, Phase 8): ⌘K anywhere opens a search over the
// projects (running first, then newest activity, as on the home page) and the
// hub's pages. Enter opens the page; ⌘Enter on a project runs its Resume.
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { FolderOpen, Inbox, Lightbulb, LayoutGrid, Search, Settings } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { sortProjects } from '../../src/server/activity.ts';
import { fetchProjects } from './api.ts';
import { openProject, resume, type Run } from './project/parts.tsx';
import { StatusBadges, useActivity } from './project/status.tsx';
import { navigate } from './router.tsx';
import { ago } from './ui.tsx';

const PAGES = [
  { to: '/', label: 'Projects', Icon: LayoutGrid },
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/ideas', label: 'Ideas', Icon: Lightbulb },
  { to: '/settings', label: 'Settings', Icon: Settings },
];

const PROJECT = 'project:';

/** The nav's search button, which also shows the shortcut. */
export function SwitcherButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-md border border-stone-200 px-2 py-1 text-sm text-stone-500 hover:border-stone-400 dark:border-stone-700"
    >
      <Search size={14} aria-hidden />
      Find
      <kbd className="rounded bg-stone-100 px-1 font-sans text-xs dark:bg-stone-800">⌘K</kbd>
    </button>
  );
}

export function Switcher({ run, open, setOpen }: { run: Run; open: boolean; setOpen: (open: boolean) => void }) {
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
      overlayClassName="fixed inset-0 z-40 bg-stone-950/40"
      contentClassName="fixed inset-x-4 top-[12vh] z-50 mx-auto max-w-xl overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900"
    >
      <div className="flex items-center gap-2 border-b border-stone-200 px-3 dark:border-stone-700">
        <Search size={16} className="text-stone-400" aria-hidden />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Find a project or page…"
          className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-stone-400"
        />
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2 text-sm">
        <Command.Empty className="px-2 py-6 text-center text-stone-500">Nothing matches.</Command.Empty>
        <Command.Group heading="Projects" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-stone-500">
          {ordered.map((p) => {
            const last = activity?.[p.slug]?.last;
            return (
              <Command.Item
                key={p.slug}
                value={`${PROJECT}${p.slug}`}
                keywords={[p.name, ...p.keywords]}
                onSelect={() => {
                  setOpen(false);
                  openProject(p.slug);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 data-[selected=true]:bg-stone-100 dark:data-[selected=true]:bg-stone-800"
              >
                <FolderOpen size={14} className="shrink-0 text-stone-400" aria-hidden />
                <span className={`min-w-0 truncate font-medium ${p.archived ? 'text-stone-500' : ''}`}>{p.name}</span>
                <span className="min-w-0 flex-1">
                  <StatusBadges project={p} activity={activity?.[p.slug]} />
                </span>
                {last && <span className="shrink-0 text-xs text-stone-500">{ago(last.at)}</span>}
              </Command.Item>
            );
          })}
        </Command.Group>
        <Command.Group heading="Pages" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-stone-500">
          {PAGES.map(({ to, label, Icon }) => (
            <Command.Item
              key={to}
              value={`page:${label}`}
              onSelect={() => go(to)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 data-[selected=true]:bg-stone-100 dark:data-[selected=true]:bg-stone-800"
            >
              <Icon size={14} className="text-stone-400" aria-hidden />
              {label}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex gap-4 border-t border-stone-200 px-3 py-2 text-xs text-stone-500 dark:border-stone-700">
        <span>↵ open</span>
        <span>⌘↵ Resume</span>
        <span>esc close</span>
      </div>
    </Command.Dialog>
  );
}

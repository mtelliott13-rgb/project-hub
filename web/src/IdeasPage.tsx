// Ideas: features wanted for the hub or a project, kept in ~/.project-hub/ideas.md
// so Claude Code can use them as its to-do list ("what's next").
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addIdea, changeIdea, deleteIdea, fetchIdeas, fetchProjects, type Idea } from './api.ts';
import type { SectionProps } from './project/sections.tsx';
import { Link } from './router.tsx';
import { Action } from './ui.tsx';

const inputClass = 'rounded-md border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-950';

function useIdeas() {
  const queryClient = useQueryClient();
  const ideas = useQuery({ queryKey: ['ideas'], queryFn: fetchIdeas });
  const onSuccess = (data: { items: Idea[] }) =>
    queryClient.setQueryData(['ideas'], (old: { file: string } | undefined) => ({ ...old, ...data }));
  const add = useMutation({ mutationFn: (v: { text: string; scope: string }) => addIdea(v.text, v.scope), onSuccess });
  const change = useMutation({
    mutationFn: (v: { idea: Idea; change: Parameters<typeof changeIdea>[1] }) => changeIdea(v.idea, v.change),
    onSuccess,
    onError: () => queryClient.invalidateQueries({ queryKey: ['ideas'] }),
  });
  const remove = useMutation({ mutationFn: deleteIdea, onSuccess, onError: () => queryClient.invalidateQueries({ queryKey: ['ideas'] }) });
  const error = ideas.error ?? add.error ?? change.error ?? remove.error;
  return { ideas, add, change, remove, error };
}

function AddIdea({ scope: fixedScope, onAdd, busy }: { scope?: string; onAdd: (v: { text: string; scope: string }) => Promise<unknown>; busy: boolean }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, enabled: !fixedScope });
  const [text, setText] = useState('');
  const [scope, setScope] = useState('hub');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void onAdd({ text, scope: fixedScope ?? scope }).then(() => setText(''));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2">
      <input
        aria-label="New idea"
        className={`${inputClass} min-w-0 flex-1`}
        placeholder={fixedScope ? 'An idea for this project…' : 'A feature you want…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {!fixedScope && (
        <select aria-label="For" className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="hub">For the hub</option>
          {projects.data
            ?.filter((p) => !p.archived)
            .map((p) => (
              <option key={p.slug} value={p.slug}>
                For {p.name}
              </option>
            ))}
        </select>
      )}
      <Action primary type="submit" disabled={busy || !text.trim()}>
        Add
      </Action>
    </form>
  );
}

function IdeaRow({ idea, scopeName, onToggle, onDelete }: { idea: Idea; scopeName?: string; onToggle: () => void; onDelete: () => void }) {
  return (
    <li data-testid="idea" data-done={idea.done} className="group flex items-start gap-2 py-1.5 text-sm">
      <input type="checkbox" checked={idea.done} onChange={onToggle} aria-label={idea.done ? 'Mark not done' : 'Mark done'} className="mt-1" />
      <span className={`min-w-0 flex-1 ${idea.done ? 'text-stone-500 line-through' : ''}`}>{idea.text}</span>
      {scopeName && <span className="shrink-0 text-xs text-stone-500">{scopeName}</span>}
      <span className="w-24 shrink-0 text-right text-xs text-stone-500">{idea.done ? `done ${idea.doneOn ?? ''}` : idea.added ? `added ${idea.added}` : ''}</span>
      <button type="button" aria-label={`Delete idea: ${idea.text}`} onClick={onDelete} className="shrink-0 text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-600">
        ✕
      </button>
    </li>
  );
}

function IdeaList({ items, names, actions }: { items: Idea[]; names?: Map<string, string>; actions: ReturnType<typeof useIdeas> }) {
  return (
    <ul className="divide-y divide-stone-100 dark:divide-stone-800">
      {items.map((i) => (
        <IdeaRow
          key={`${i.line}:${i.text}`}
          idea={i}
          scopeName={names && (i.scope === 'hub' ? 'Hub' : (names.get(i.scope) ?? i.scope))}
          onToggle={() => actions.change.mutate({ idea: i, change: { done: !i.done } })}
          onDelete={() => confirm(`Delete this idea?\n\n${i.text}`) && actions.remove.mutate(i)}
        />
      ))}
    </ul>
  );
}

export function IdeasPage() {
  const actions = useIdeas();
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const names = new Map(projects.data?.map((p) => [p.slug, p.name]));
  const items = actions.ideas.data?.items ?? [];
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Ideas</h1>
        <p className="mt-1 text-sm text-stone-500">
          Features you want, for the hub or a project. Kept in {actions.ideas.data?.file.replace(/^\/(Users|home)\/[^/]+/, '~') ?? '~/.project-hub/ideas.md'}; ask Claude
          Code in ~/project-hub "what's next" and it works through the open ones, top first, ticking them off as they're built.
        </p>
      </div>
      <AddIdea onAdd={(v) => actions.add.mutateAsync(v)} busy={actions.add.isPending} />
      {actions.error && <p className="text-sm text-red-600">{actions.error.message}</p>}
      <section>
        <h2 className="text-xs font-medium tracking-wide text-stone-500 uppercase">Open ({open.length})</h2>
        {open.length ? <IdeaList items={open} names={names} actions={actions} /> : <p className="mt-1 text-sm text-stone-500">Nothing open.</p>}
      </section>
      {done.length > 0 && (
        <section>
          <h2 className="text-xs font-medium tracking-wide text-stone-500 uppercase">Done ({done.length})</h2>
          <IdeaList items={done} names={names} actions={actions} />
        </section>
      )}
    </div>
  );
}

/** The project page's section: this project's ideas, and adding one. */
export function ProjectIdeas({ project }: SectionProps) {
  const actions = useIdeas();
  const items = (actions.ideas.data?.items ?? []).filter((i) => i.scope === project.slug);
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  return (
    <div className="space-y-2">
      {open.length > 0 ? <IdeaList items={open} actions={actions} /> : <p className="text-[13px] text-muted">None open</p>}
      {done.length > 0 && <p className="text-xs text-stone-500">{done.length} done. See all on the <Link to="/ideas" className="underline">Ideas page</Link>.</p>}
      <AddIdea scope={project.slug} onAdd={(v) => actions.add.mutateAsync(v)} busy={actions.add.isPending} />
      {actions.error && <p className="text-sm text-red-600">{actions.error.message}</p>}
    </div>
  );
}

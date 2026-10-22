// The Inbox (SPEC.md, Phase 6): links no rule matched and sessions no folder
// matched. Select one with ↑/↓ (or j/k) and press a project's number to file
// it; then A saves "always file these here", so the next one files itself.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  addLink,
  addRule,
  deleteLink,
  deleteRule,
  fetchInbox,
  fetchProjects,
  fetchRules,
  fileLink,
  fileSession,
  type InboxSession,
  type LinkDto,
  type ProjectDto,
} from './api.ts';
import type { Run } from './project/parts.tsx';
import { Action, ago, shortenHome } from './ui.tsx';

const inputClass = 'rounded-md border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-950';

type Item = { kind: 'link'; at: string; link: LinkDto } | { kind: 'session'; at: string; session: InboxSession };
const itemKey = (i: Item) => (i.kind === 'link' ? `l${i.link.id}` : `s${i.session.id}`);

/** What was just filed, so A can save its rule and Z can undo it. */
type Filed = { kind: 'link'; link: LinkDto; slug: string; choice: number } | { kind: 'session'; session: InboxSession; slug: string };

export const linkLabel = (l: { title: string | null; url: string }) => l.title ?? l.url.replace(/^https?:\/\/(www\.)?/, '');

/** Pastes a link: into `slug` when given, else wherever the rules say, else the Inbox. */
export function AddLinkForm({ slug, onAdded }: { slug?: string; onAdded?: (where: string) => void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: () => addLink({ url, ...(title.trim() && { title }), ...(slug && { slug }) }),
    onSuccess: ({ link, existed }) => {
      setUrl('');
      setTitle('');
      onAdded?.(`${existed ? 'Already saved; updated' : 'Saved'}: ${link.projectSlug ? `filed to ${link.projectSlug}${link.filedBy === 'manual' ? '' : ` (${link.filedBy})`}` : 'in the Inbox'}`);
      void queryClient.invalidateQueries();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <input aria-label="Link" className={`${inputClass} min-w-48 flex-[2]`} placeholder="Paste a link (Google Doc, Figma, ticket…)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input aria-label="Title" className={`${inputClass} min-w-32 flex-1`} placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Action primary type="submit" disabled={add.isPending || !url.trim()}>
          Add
        </Action>
      </div>
      {add.error && <p className="text-sm text-red-600">{add.error.message}</p>}
    </form>
  );
}

export function InboxPage({ run }: { run: Run }) {
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: fetchInbox });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const rules = useQuery({ queryKey: ['rules'], queryFn: fetchRules });
  const [selected, setSelected] = useState(0);
  const [filed, setFiled] = useState<Filed | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const active = (projects.data ?? []).filter((p) => !p.archived);
  const name = (slug: string) => projects.data?.find((p) => p.slug === slug)?.name ?? slug;
  const items: Item[] = [
    ...(inbox.data?.links ?? []).map((link) => ({ kind: 'link' as const, at: link.createdAt, link })),
    ...(inbox.data?.sessions ?? []).map((session) => ({ kind: 'session' as const, at: session.lastActiveAt, session })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const current = items[Math.min(selected, items.length - 1)];

  const refresh = () => queryClient.invalidateQueries();
  const fail = (e: Error) => setMessage({ ok: false, text: e.message });

  const file = useMutation({
    mutationFn: async ({ item, slug }: { item: Item; slug: string }): Promise<Filed> => {
      if (item.kind === 'link') return { kind: 'link', link: (await fileLink(item.link.id, slug)).link, slug, choice: item.link.suggested };
      await fileSession(item.session.id, slug, false);
      return { kind: 'session', session: item.session, slug };
    },
    onSuccess: (f) => {
      setFiled(f);
      setMessage(null);
      void refresh();
    },
    onError: fail,
  });

  const always = useMutation({
    mutationFn: async (f: Filed) => {
      if (f.kind === 'link') {
        const choice = f.link.choices[f.choice];
        const { filed: n } = await addRule(f.slug, choice);
        return `Saved: links to ${choice.label} now file into ${name(f.slug)}.${n ? ` ${n} more from the Inbox filed.` : ''}`;
      }
      await fileSession(f.session.id, f.slug, true);
      return `Saved: sessions in ${shortenHome(f.session.folder)} now file into ${name(f.slug)} (added to its folders in projects.yaml).`;
    },
    onSuccess: (text) => {
      setFiled(null);
      setMessage({ ok: true, text });
      void refresh();
    },
    onError: fail,
  });

  const undo = useMutation({
    mutationFn: (f: Filed & { kind: 'link' }) => fileLink(f.link.id, null),
    onSuccess: () => {
      setFiled(null);
      setMessage({ ok: true, text: 'Moved back to the Inbox.' });
      void refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (l: LinkDto) => deleteLink(l.id),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  // One-key filing. Keys are ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [role=dialog]')) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (e.key === 'ArrowDown' || e.key === 'j') setSelected((s) => Math.min(s + 1, items.length - 1));
      else if (e.key === 'ArrowUp' || e.key === 'k') setSelected((s) => Math.max(s - 1, 0));
      else if (n && current && active[Number(n) - 1] && !file.isPending) file.mutate({ item: current, slug: active[Number(n) - 1].slug });
      else if ((e.key === 'a' || e.key === 'A') && filed && !(filed.kind === 'session' && filed.session.folderProblem)) always.mutate(filed);
      else if ((e.key === 'z' || e.key === 'Z') && filed?.kind === 'link') undo.mutate(filed);
      else if (e.key === 'Escape') setFiled(null);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && current?.kind === 'link') {
        if (confirm(`Delete this link?\n\n${current.link.url}`)) remove.mutate(current.link);
      } else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  // Keep the selected row in view.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, items.length]);

  return (
    <div className="space-y-6" data-testid="inbox-page">
      <div>
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="mt-1 text-sm text-stone-500">
          Links no rule matched and Claude Code sessions outside every project's folders. Select one with ↑/↓ (or j/k), press a project's number to file it, then A to
          always file ones like it there.
        </p>
      </div>
      <AddLinkForm onAdded={(text) => setMessage({ ok: true, text })} />

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="inbox-keys">
        {active.slice(0, 9).map((p, i) => (
          <span key={p.slug}>
            <kbd className="rounded border border-stone-300 px-1 font-mono text-xs dark:border-stone-700">{i + 1}</kbd> {p.name}
          </span>
        ))}
      </div>

      {filed && <FiledBar filed={filed} name={name} setFiled={setFiled} onAlways={() => always.mutate(filed)} onUndo={() => filed.kind === 'link' && undo.mutate(filed)} busy={always.isPending} />}
      {message && (
        <p data-testid="inbox-message" className={`rounded-md px-3 py-2 text-sm ${message.ok ? 'bg-stone-100 dark:bg-stone-900' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'}`}>
          {message.text}
        </p>
      )}

      <section>
        <h2 className="text-xs font-medium tracking-wide text-stone-500 uppercase">Waiting ({items.length})</h2>
        {inbox.isPending && <p className="text-sm text-stone-500">Loading…</p>}
        {inbox.error && <p className="text-sm text-red-600">{inbox.error.message}</p>}
        {inbox.data && items.length === 0 && <p className="mt-1 text-sm text-stone-500">Nothing to file.</p>}
        <ul ref={listRef} className="mt-1 divide-y divide-stone-100 dark:divide-stone-800">
          {items.map((item, i) => (
            <InboxRow
              key={itemKey(item)}
              item={item}
              selected={item === current}
              onSelect={() => setSelected(i)}
              projects={active}
              onFile={(slug) => file.mutate({ item, slug })}
              onDelete={() => item.kind === 'link' && confirm(`Delete this link?\n\n${item.link.url}`) && remove.mutate(item.link)}
              run={run}
            />
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-xs font-medium tracking-wide text-stone-500 uppercase">Rules ({rules.data?.length ?? 0})</h2>
        <p className="mt-1 text-xs text-stone-500">
          A link files into the project of the most specific rule that matches it. Links to a project's GitHub repo or Claude Project file there without a rule.
        </p>
        <ul className="mt-1 text-sm" data-testid="rules">
          {rules.data?.map((r) => (
            <li key={r.id} className="group flex items-center gap-2 py-0.5">
              <span className="font-mono text-xs">
                {r.host}
                {r.pathPrefix}
              </span>
              <span className="text-stone-500">→ {name(r.projectSlug)}</span>
              <button
                type="button"
                aria-label={`Delete rule ${r.host}${r.pathPrefix}`}
                onClick={() => confirm(`Stop filing ${r.host}${r.pathPrefix} links into ${name(r.projectSlug)}? Links already filed stay where they are.`) && deleteRule(r.id).then(refresh, fail)}
                className="text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-600"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function FiledBar({
  filed,
  name,
  setFiled,
  onAlways,
  onUndo,
  busy,
}: {
  filed: Filed;
  name: (slug: string) => string;
  setFiled: (f: Filed | null) => void;
  onAlways: () => void;
  onUndo: () => void;
  busy: boolean;
}) {
  const kbd = (k: string) => <kbd className="rounded border border-stone-300 px-1 font-mono text-xs dark:border-stone-700">{k}</kbd>;
  return (
    <div data-testid="filed-bar" className="flex flex-wrap items-center gap-2 rounded-md bg-green-50 px-3 py-2 text-sm dark:bg-green-950">
      <span>
        Filed {filed.kind === 'link' ? `"${linkLabel(filed.link)}"` : 'the session'} to <b>{name(filed.slug)}</b>.
      </span>
      {filed.kind === 'link' ? (
        <>
          <Action small disabled={busy} onClick={onAlways}>
            Always file
          </Action>
          <select
            aria-label="Rule"
            className={`${inputClass} py-0.5 text-xs`}
            value={filed.choice}
            onChange={(e) => setFiled({ ...filed, choice: Number(e.target.value) })}
          >
            {filed.link.choices.map((c, i) => (
              <option key={c.label} value={i}>
                {c.pathPrefix ? `${c.label}/…` : `anything on ${c.label}`}
              </option>
            ))}
          </select>
          <span>here {kbd('A')}</span>
          <button type="button" className="text-xs underline" onClick={onUndo}>
            Undo
          </button>
          {kbd('Z')}
        </>
      ) : filed.session.folderProblem ? (
        <span className="text-xs text-stone-500">Its folder is too broad for a rule, so only this session was filed.</span>
      ) : (
        <>
          <Action small disabled={busy} onClick={onAlways}>
            Always file sessions in {shortenHome(filed.session.folder)} here
          </Action>
          {kbd('A')}
        </>
      )}
      <span className="flex-1" />
      <button type="button" aria-label="Dismiss" className="text-stone-500" onClick={() => setFiled(null)}>
        ✕
      </button>
    </div>
  );
}

function InboxRow({
  item,
  selected,
  onSelect,
  projects,
  onFile,
  onDelete,
  run,
}: {
  item: Item;
  selected: boolean;
  onSelect: () => void;
  projects: ProjectDto[];
  onFile: (slug: string) => void;
  onDelete: () => void;
  run: Run;
}) {
  return (
    <li
      data-testid="inbox-item"
      data-kind={item.kind}
      data-selected={selected}
      onClick={onSelect}
      className={`flex items-center gap-2 px-2 py-1.5 text-sm ${selected ? 'bg-stone-100 ring-1 ring-stone-300 dark:bg-stone-800 dark:ring-stone-600' : ''}`}
    >
      <span className="w-14 shrink-0 text-xs text-stone-500">{item.kind === 'link' ? 'Link' : 'Session'}</span>
      {item.kind === 'link' ? (
        <span className="min-w-0 flex-1 truncate">
          <a href={item.link.url} target="_blank" rel="noreferrer" className="hover:underline">
            {linkLabel(item.link)}
          </a>
          {item.link.title && <span className="ml-2 text-xs text-stone-500">{item.link.url.replace(/^https?:\/\/(www\.)?/, '')}</span>}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {item.session.title ?? <span className="text-stone-500">Untitled session</span>}
          <span className="ml-2 font-mono text-xs text-stone-500">{shortenHome(item.session.cwd)}</span>
        </span>
      )}
      <span className="w-16 shrink-0 text-right text-xs text-stone-500">{ago(item.at)}</span>
      <select aria-label="File to" className={`${inputClass} w-36 shrink-0 py-0.5 text-xs`} value="" onChange={(e) => e.target.value && onFile(e.target.value)}>
        <option value="">File to…</option>
        {projects.map((p, i) => (
          <option key={p.slug} value={p.slug}>
            {i < 9 ? `${i + 1}  ` : ''}
            {p.name}
          </option>
        ))}
      </select>
      {item.kind === 'link' ? (
        <button type="button" aria-label={`Delete link ${item.link.url}`} onClick={onDelete} className="shrink-0 text-stone-400 hover:text-red-600">
          ✕
        </button>
      ) : (
        item.session.resumeProblem === null && (
          <Action small title="Resume in Terminal" onClick={() => run({ kind: 'session', sessionId: item.session.id })}>
            Terminal
          </Action>
        )
      )}
    </li>
  );
}

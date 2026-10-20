// Picks folders or repos from a list (suggestions, or browsing ~), never typed.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { browseFolder, folderSuggestions, type FolderEntry } from './api.ts';
import { Action, shortenHome } from './ui.tsx';

type Props = {
  label: string;
  /** Repos must be git repos; folders can be any folder. */
  kind: 'repos' | 'folders';
  value: string[];
  onChange: (paths: string[]) => void;
};

export function FolderPicker({ label, kind, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const add = (p: string) => !value.includes(p) && onChange([...value, p]);

  return (
    <fieldset className="space-y-1.5" data-testid={`picker-${kind}`}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {value.length === 0 && <p className="text-xs text-stone-500">None</p>}
      <ul className="space-y-1">
        {value.map((p) => (
          <li key={p} className="flex items-center gap-2 rounded bg-stone-100 px-2 py-1 font-mono text-xs dark:bg-stone-800">
            <span className="min-w-0 flex-1 break-all">{shortenHome(p)}</span>
            <button type="button" aria-label={`Remove ${p}`} className="text-stone-500 hover:text-red-600" onClick={() => onChange(value.filter((v) => v !== p))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <PickerPanel kind={kind} chosen={value} onPick={add} onDone={() => setOpen(false)} />
      ) : (
        <Action small onClick={() => setOpen(true)}>
          + Add {kind === 'repos' ? 'repo' : 'folder'}
        </Action>
      )}
    </fieldset>
  );
}

function PickerPanel({ kind, chosen, onPick, onDone }: { kind: Props['kind']; chosen: string[]; onPick: (p: string) => void; onDone: () => void }) {
  const [tab, setTab] = useState<'suggested' | 'browse'>('suggested');
  const [at, setAt] = useState<string | undefined>(undefined);
  const suggested = useQuery({ queryKey: ['folder-suggestions'], queryFn: folderSuggestions, enabled: tab === 'suggested' });
  const browsing = useQuery({ queryKey: ['browse', at ?? '~'], queryFn: () => browseFolder(at), enabled: tab === 'browse' });
  const pickable = (e: { isRepo: boolean; path: string }) => (kind === 'folders' || e.isRepo) && !chosen.includes(e.path);
  const list = tab === 'suggested' ? (suggested.data ?? []).filter((e) => kind === 'folders' || e.isRepo) : (browsing.data?.entries ?? []);
  const error = tab === 'suggested' ? suggested.error : browsing.error;
  const loading = tab === 'suggested' ? suggested.isPending : browsing.isPending;

  const tabClass = (t: typeof tab) =>
    `px-2 py-1 text-xs font-medium ${tab === t ? 'border-b-2 border-stone-900 dark:border-stone-100' : 'text-stone-500'}`;

  return (
    <div className="rounded-md border border-stone-300 p-2 dark:border-stone-700">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" className={tabClass('suggested')} onClick={() => setTab('suggested')}>
          Suggested
        </button>
        <button type="button" className={tabClass('browse')} onClick={() => setTab('browse')}>
          Browse
        </button>
        <span className="flex-1" />
        <Action small onClick={onDone}>
          Done
        </Action>
      </div>

      {tab === 'browse' && browsing.data && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <button
            type="button"
            disabled={!browsing.data.parent}
            className="rounded border border-stone-300 px-1.5 disabled:opacity-30 dark:border-stone-700"
            onClick={() => setAt(browsing.data.parent ?? undefined)}
            aria-label="Up one folder"
          >
            ↑
          </button>
          <span className="min-w-0 flex-1 truncate font-mono">{shortenHome(browsing.data.path)}</span>
          {pickable(browsing.data) && (
            <Action small onClick={() => onPick(browsing.data.path)}>
              Add this folder
            </Action>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error.message}</p>}
      <ul className="max-h-56 overflow-y-auto text-sm">
        {list.map((e: FolderEntry) => (
          <li key={e.path} className="flex items-center gap-2 py-0.5">
            {tab === 'browse' ? (
              <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setAt(e.path)} title="Open">
                📁 {e.name}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.path}>
                {shortenHome(e.path)}
              </span>
            )}
            {e.isRepo && <span className="shrink-0 rounded bg-stone-200 px-1 text-[10px] dark:bg-stone-700">git</span>}
            {chosen.includes(e.path) ? (
              <span className="shrink-0 text-xs text-stone-500">added</span>
            ) : (
              pickable(e) && (
                <Action small onClick={() => onPick(e.path)}>
                  Add
                </Action>
              )
            )}
          </li>
        ))}
        {loading && <li className="py-1 text-xs text-stone-500">Loading…</li>}
        {list.length === 0 && !error && !loading && (
          <li className="py-1 text-xs text-stone-500">
            {tab === 'suggested' ? `No ${kind === 'repos' ? 'repos' : 'folders'} to suggest. Try Browse.` : 'No folders here.'}
          </li>
        )}
      </ul>
      {kind === 'repos' && <p className="mt-1 text-[11px] text-stone-500">Only git repos can be added here. Add other folders under Folders.</p>}
    </div>
  );
}

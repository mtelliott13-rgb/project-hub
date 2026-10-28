// The project's checklist from its toolkit.yaml (the file stays the source of
// truth). In-progress items first, then each category. Changing a status
// writes just that value back; if the file changed meanwhile, nothing is
// written and the current version is shown instead.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchToolkit, HubError, setToolkitStatus, toolkitOk, type Toolkit, type ToolkitResponse, type ToolkitStatus } from '../api.ts';
import { shortenHome } from '../ui.tsx';
import { groupToolkit, isOverdue, STATUS_OPTIONS } from '../toolkit-view.ts';
import type { SectionProps } from './sections.tsx';

type Item = Toolkit['items'][number];

const statusLook: Record<ToolkitStatus, string> = {
  'not started': 'border-stone-300 dark:border-stone-700',
  'in progress': 'border-amber-400 bg-amber-50 dark:bg-amber-950',
  done: 'border-green-500 bg-green-50 dark:bg-green-950',
  parked: 'border-stone-300 bg-stone-100 text-stone-500 dark:border-stone-700 dark:bg-stone-800',
};

function Row({ item, showCategory, onChange, busy }: { item: Item; showCategory: boolean; onChange: (s: ToolkitStatus) => void; busy: boolean }) {
  const overdue = isOverdue(item, new Date());
  return (
    <li data-testid="toolkit-item" data-status={item.status} className={`flex gap-3 py-2 ${item.status === 'parked' ? 'opacity-60' : ''}`}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer noopener" className="font-medium hover:underline">
              {item.name}
            </a>
          ) : (
            <span className="font-medium">{item.name}</span>
          )}
          {showCategory && <span className="text-xs text-stone-500">{item.category}</span>}
          {item.cost && <span className="text-xs text-stone-600 dark:text-stone-400">{item.cost}</span>}
          {item.target && (
            <span className={`text-xs ${overdue ? 'font-medium text-red-600' : 'text-stone-500'}`}>
              target {item.target}
              {overdue && ' (past)'}
            </span>
          )}
        </div>
        {item.why && <p className="text-sm text-stone-600 dark:text-stone-400">{item.why}</p>}
        {item.notes && (
          <p data-testid="toolkit-notes" className="text-xs whitespace-pre-line text-stone-500">
            {item.notes}
          </p>
        )}
        {!item.url && item.urlText && <p className="font-mono text-xs break-all text-stone-500">{item.urlText}</p>}
      </div>
      <select
        aria-label={`Status of ${item.name}`}
        value={item.unknownStatus ? '' : item.status}
        disabled={busy}
        onChange={(e) => onChange(e.target.value as ToolkitStatus)}
        className={`h-8 shrink-0 rounded-md border px-1.5 text-sm ${statusLook[item.status]}`}
      >
        {item.unknownStatus && (
          <option value="" disabled>
            "{item.unknownStatus}" (not a status)
          </option>
        )}
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </li>
  );
}

export function ToolkitSection({ project }: SectionProps) {
  const slug = project.slug;
  const queryClient = useQueryClient();
  const toolkit = useQuery({ queryKey: ['toolkit', slug], queryFn: () => fetchToolkit(slug) });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const change = useMutation({
    mutationFn: ({ item, status, version }: { item: Item; status: ToolkitStatus; version: string }) => setToolkitStatus(slug, item, status, version),
    onSuccess: (t, { item, status }) => {
      queryClient.setQueryData<ToolkitResponse>(['toolkit', slug], (old) => ({ ...t, others: toolkitOk(old) ? old.others : [] }));
      setNotice({ ok: true, text: `Saved: "${item.name}" is now ${status}.` });
    },
    onError: (e: Error) => {
      setNotice({ ok: false, text: e.message });
      // 409: the file changed underneath. Show what's there now.
      const current = e instanceof HubError && e.status === 409 ? (e.body.current as Toolkit | null) : null;
      if (current) queryClient.setQueryData<ToolkitResponse>(['toolkit', slug], (old) => ({ ...current, others: toolkitOk(old) ? old.others : [] }));
      else void queryClient.invalidateQueries({ queryKey: ['toolkit', slug] });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const t = toolkit.data;
  if (toolkit.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (toolkit.error) return <p className="text-sm text-red-600">{toolkit.error.message}</p>;
  if (!t) return null;
  if (!toolkitOk(t)) return <p className="text-sm text-red-600">{'error' in t ? t.error : 'Unreadable toolkit.yaml'}</p>;

  const groups = groupToolkit(t.items);
  return (
    <div className="space-y-3" data-testid="toolkit">
      <p className="text-sm">
        <strong>
          {t.done} of {t.total} done
        </strong>
        <span className="text-stone-500">
          {' '}
          · from {shortenHome(t.file)}
          {t.items.length > t.total && ` · ${t.items.length - t.total} parked, not counted`}
        </span>
      </p>
      {notice && (
        <p data-testid="toolkit-notice" className={`rounded-md px-3 py-2 text-sm ${notice.ok ? 'bg-stone-100 text-stone-700 dark:bg-stone-900 dark:text-stone-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}>
          {notice.text}
        </p>
      )}
      {t.problems.map((p) => (
        <p key={p} className="text-xs text-amber-700">
          {p}
        </p>
      ))}
      {t.others.length > 0 && <p className="text-xs text-amber-700">Also found {t.others.map(shortenHome).join(', ')}; only the first is used.</p>}
      {groups.map((g) => (
        <div key={g.title} data-testid="toolkit-group">
          <h3 className="text-xs font-medium tracking-wide text-stone-500 uppercase">
            {g.title} ({g.items.length})
          </h3>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {g.items.map((item) => (
              <Row
                key={`${item.index}:${item.name}`}
                item={item}
                showCategory={g.inProgress}
                busy={change.isPending}
                onChange={(status) => change.mutate({ item, status, version: t.version })}
              />
            ))}
          </ul>
        </div>
      ))}
      {t.items.length === 0 && <p className="text-sm text-stone-500">The list is empty.</p>}
    </div>
  );
}

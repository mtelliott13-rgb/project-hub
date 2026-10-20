// Monetize: Generate asks Claude (read-only, plus web search) for a draft of how
// the project could make money. Every draft is kept; each one can be edited.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { fetchDraft, fetchMonetize, generateDraft, saveDraft, type DraftMeta } from '../api.ts';
import { saveLabel, useAutosave } from '../autosave.ts';
import { Action, ago } from '../ui.tsx';
import type { SectionProps } from './sections.tsx';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const draftLabel = (d: DraftMeta, i: number) =>
  `${when(d.generatedAt)}${d.costUsd !== null ? ` · $${d.costUsd.toFixed(2)}` : ''}${d.editedAt ? ' · edited' : ''}${i === 0 ? ' (latest)' : ''}`;

export function MonetizeSection({ project }: SectionProps) {
  const slug = project.slug;
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ['monetize', slug], queryFn: () => fetchMonetize(slug) });
  const generate = useMutation({
    mutationFn: () => generateDraft(slug),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['monetize', slug] }),
  });
  const drafts = info.data?.drafts ?? [];
  const job = info.data?.job ?? null;
  const running = job?.state === 'running' || generate.isPending;

  // Show the newest draft, and jump to a new one when Generate finishes.
  const [selected, setSelected] = useState<string | null>(null);
  const newest = useRef<string | undefined>(undefined);
  useEffect(() => {
    const top = drafts[0]?.id;
    if (top && top !== newest.current) {
      if (newest.current !== undefined || selected === null) setSelected(top);
      newest.current = top;
    }
  }, [drafts, selected]);

  return (
    <div className="space-y-3" data-testid="monetize">
      <div className="flex flex-wrap items-center gap-2">
        <Action primary disabled={running || info.isPending} onClick={() => generate.mutate()}>
          {running ? 'Generating…' : drafts.length ? 'Generate another draft' : 'Generate'}
        </Action>
        {drafts.length > 0 && (
          <select
            aria-label="Draft"
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-950"
          >
            {drafts.map((d, i) => (
              <option key={d.id} value={d.id}>
                {draftLabel(d, i)}
              </option>
            ))}
          </select>
        )}
      </div>
      {job?.state === 'running' && (
        <p className="text-sm text-stone-500">
          Claude is reading the project and searching the web (started {ago(job.startedAt)}). This usually takes a few minutes; you can leave the page.
        </p>
      )}
      {job?.state === 'failed' && <p className="text-sm text-red-600">The last Generate failed: {job.error}</p>}
      {generate.error && <p className="text-sm text-red-600">{generate.error.message}</p>}
      {drafts.length === 0 && !running && (
        <p className="text-sm text-stone-500">
          No draft yet. Generate runs Claude in this project's folders to draft who would pay, what they'd pay for, pricing ideas,
          what it would take to get there, and the first 3 steps. It runs only when you click, and uses your Claude usage.
        </p>
      )}
      {selected && <DraftEditor key={selected} slug={slug} id={selected} />}
      {info.data && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer">Exact command Generate runs</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-stone-100 p-2 whitespace-pre-wrap dark:bg-stone-900">{info.data.command}</pre>
          <p className="mt-1">Claude can read this project's folders and search the web. It can't edit files, run commands or use your settings, and the run isn't saved as a session.</p>
        </details>
      )}
    </div>
  );
}

function DraftEditor({ slug, id }: { slug: string; id: string }) {
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: ['draft', slug, id], queryFn: () => fetchDraft(slug, id), staleTime: Infinity });
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null && loaded.data) setText(loaded.data.text);
  }, [loaded.data, text]);
  const save = useAutosave(
    text ?? '',
    async (t) => {
      await saveDraft(slug, id, t);
      void queryClient.invalidateQueries({ queryKey: ['monetize', slug] });
    },
    text !== null,
  );

  if (loaded.error) return <p className="text-sm text-red-600">{loaded.error.message}</p>;
  if (text === null) return <p className="text-sm text-stone-500">Loading draft…</p>;
  return (
    <div>
      <textarea
        data-testid="monetize-draft"
        aria-label="Monetize draft"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(40, Math.max(14, text.split('\n').length + 2))}
        className="w-full resize-y rounded-md border border-stone-300 bg-white p-3 font-mono text-[13px] leading-relaxed dark:border-stone-700 dark:bg-stone-950"
      />
      <p className={`h-4 text-xs ${save.state === 'error' ? 'text-red-600' : 'text-stone-500'}`}>{saveLabel(save.state, save.error)}</p>
    </div>
  );
}

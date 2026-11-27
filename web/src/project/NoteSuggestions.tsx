// "Add to calendar?" next to note lines that mention a date or time. Lines are
// found locally (note-dates.ts); a line goes to the quick-add parser only when
// you click its suggestion, then you get the same preview card as quick-add.
// Nothing is ever created from notes on its own. Dismissed lines (and lines
// you added) are remembered by a hash of the line and not offered again.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sha256Hex } from '../../../src/server/queue-rules.ts';
import { dismissNoteLine, fetchCalendarDefaults, fetchNoteDismissals, fetchProjects, parseQuickAdd, type CreatedDto, type ReminderDraft } from '../api.ts';
import { IconButton } from '../ui.tsx';
import { previewParts } from '../today/model.ts';
import { FALLBACK_DEFAULTS, PreviewCard, ReminderForm, UndoToast, type Toast } from '../today/QuickAdd.tsx';
import { datedLines, type DatedLine } from './note-dates.ts';

const SHOWN = 3;

/** The text after you stop typing for a moment, so suggestions don't flicker mid-line. */
function useSettled(text: string, ms = 800): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setSettled(text), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return settled;
}

type Open = { hash: string; kind: 'preview' | 'form'; draft: ReminderDraft; reason: string | null };

export function NoteSuggestions({ slug, text }: { slug: string; text: string }) {
  const queryClient = useQueryClient();
  const settled = useSettled(text);
  const dismissed = useQuery({ queryKey: ['note-dismissals', slug], queryFn: () => fetchNoteDismissals(slug) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects }).data ?? [];
  const defaults = useQuery({ queryKey: ['calendar-defaults'], queryFn: fetchCalendarDefaults }).data ?? FALLBACK_DEFAULTS;
  const [hashed, setHashed] = useState<(DatedLine & { hash: string })[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let live = true;
    const lines = datedLines(settled);
    void Promise.all(lines.map(async (l) => ({ ...l, hash: await sha256Hex(l.line) }))).then((h) => live && setHashed(h));
    return () => {
      live = false;
    };
  }, [settled]);

  const dismiss = useMutation({
    mutationFn: (hash: string) => dismissNoteLine(slug, hash),
    onMutate: (hash) => queryClient.setQueryData<string[]>(['note-dismissals', slug], (d) => [...(d ?? []), hash]),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['note-dismissals', slug] }),
  });
  const parse = useMutation({
    mutationFn: (l: DatedLine & { hash: string }) => parseQuickAdd(l.text),
    onSuccess: (r, l) => {
      // A line in this project's notes belongs to this project unless the parser says otherwise.
      const draft = { ...r.draft, project: r.draft.project ?? slug };
      setOpen(r.status === 'preview' ? { hash: l.hash, kind: 'preview', draft, reason: null } : { hash: l.hash, kind: 'form', draft, reason: r.reason });
    },
  });

  if (!dismissed.data) return null;
  const left = hashed.filter((l) => !dismissed.data.includes(l.hash));
  if (left.length === 0 && !open && !toast) return null;
  const shown = all ? left : left.slice(0, SHOWN);
  const added = (created: CreatedDto, title: string) => {
    if (open) dismiss.mutate(open.hash);
    setOpen(null);
    setToast({ created, title });
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'notes' });
  };

  return (
    <section className="mt-3 space-y-2" aria-labelledby={`note-dates-${slug}`} data-testid="note-suggestions">
      {left.length > 0 && (
        <>
          <h3 id={`note-dates-${slug}`} className="text-tiny font-semibold tracking-[0.08em] text-muted uppercase">
            Dates in these notes
          </h3>
          <ul className="space-y-1">
            {shown.map((l) => (
              <li key={l.hash} className="flex items-center gap-2 rounded-btn bg-soft px-2 py-1.5" data-testid="note-suggestion">
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={l.line}>
                  {l.text}
                </span>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-0.5 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                  onClick={() => parse.mutate(l)}
                  disabled={parse.isPending}
                  aria-label={`Add to calendar? "${l.text}"`}
                >
                  <CalendarPlus size={12} aria-hidden /> {parse.isPending && parse.variables?.hash === l.hash ? 'Reading…' : 'Add to calendar?'}
                </button>
                <IconButton label={`Don't suggest "${l.text}" again`} onClick={() => dismiss.mutate(l.hash)} className="size-6">
                  <X size={12} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
          {left.length > SHOWN && (
            <button type="button" className="text-[12px] text-muted hover:text-ink hover:underline" onClick={() => setAll(!all)} aria-expanded={all}>
              {all ? 'Show fewer' : `Show ${left.length - SHOWN} more`}
            </button>
          )}
        </>
      )}
      {parse.error && (
        <p role="alert" className="text-[12px] text-red-700 dark:text-red-300">
          {parse.error.message}
        </p>
      )}
      {open?.kind === 'preview' && (
        <PreviewCard
          draft={open.draft}
          parts={previewParts(open.draft, defaults, open.draft.project ? (projects.find((p) => p.slug === open.draft.project)?.name ?? null) : null)}
          onAdded={added}
          onEdit={() => setOpen({ ...open, kind: 'form' })}
          onCancel={() => setOpen(null)}
        />
      )}
      {open?.kind === 'form' && <ReminderForm draft={open.draft} reason={open.reason} projects={projects} defaults={defaults} onAdded={added} onCancel={() => setOpen(null)} />}
      {toast && <UndoToast toast={toast} setToast={setToast} />}
    </section>
  );
}

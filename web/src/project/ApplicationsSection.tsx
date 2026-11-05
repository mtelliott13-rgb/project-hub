// Applications: Career HQ's review queue (jobs/queue/review_queue.yaml; the
// file stays the source of truth). One card per application, drafts first and
// then by deadline. Changing a status writes just that value back (and
// submitted_on); if the file changed meanwhile, nothing is written and the
// current version is shown. Clicking a card shows its fill sheet with a Copy
// button on every field. Everything is read from local disk by the hub.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, FileText } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { APP_STATUSES, queueSummary, sortApplications, type AppStatus } from '../../../src/server/queue-rules.ts';
import { fetchFillSheet, fetchQueue, HubError, queueOk, setApplicationStatus, type Application, type FillPart, type Queue } from '../api.ts';
import { Action, Modal, shortenHome } from '../ui.tsx';
import type { SectionProps } from './sections.tsx';

const statusLook: Record<AppStatus, string> = {
  draft: 'border-stone-300 dark:border-stone-700',
  reviewed: 'border-sky-400 bg-sky-50 dark:bg-sky-950',
  submitted: 'border-green-500 bg-green-50 dark:bg-green-950',
};

const fitLook: Record<string, string> = {
  strong: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  possible: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  stretch: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  skip: 'bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400',
};

const fmtDate = (ymd: string | null) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const d = new Date(`${ymd}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

/** Days until a YYYY-MM-DD deadline (negative once past), or null. */
const daysLeft = (ymd: string | null) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((new Date(`${ymd}T00:00:00`).getTime() - start) / 86_400_000);
};

function Deadline({ app }: { app: Application }) {
  const left = daysLeft(app.deadline);
  if (!app.deadline) return null;
  const open = app.status !== 'submitted';
  const urgent = open && left !== null && left <= 7;
  return (
    <span className={urgent ? 'font-medium text-red-600 dark:text-red-400' : ''} data-testid="deadline">
      deadline {fmtDate(app.deadline)}
      {open && left !== null && (left < 0 ? ' (passed)' : left === 0 ? ' (today)' : left <= 7 ? ` (${left}d left)` : '')}
    </span>
  );
}

function Card({ app, slug, run, busy, onStatus, onOpen }: { app: Application; slug: string; run: SectionProps['run']; busy: boolean; onStatus: (s: AppStatus) => void; onOpen: () => void }) {
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, select, input')) return;
    if (app.files.fillSheet) onOpen();
  };
  const facts = [app.location, app.added && `added ${fmtDate(app.added)}`, app.status === 'submitted' && app.submittedOn && `submitted ${fmtDate(app.submittedOn)}`].filter(Boolean);
  return (
    <li
      data-testid="application"
      data-status={app.status}
      onClick={open}
      className={`rounded-lg border border-stone-200 p-3 dark:border-stone-800 ${app.files.fillSheet ? 'cursor-pointer hover:border-stone-400 dark:hover:border-stone-600' : ''}`}
      title={app.files.fillSheet ? 'Show the fill sheet' : 'No fill_sheet.md in this packet'}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {app.company} <span className="text-stone-500">·</span> {app.title}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-stone-500">
            {facts.map((f) => (
              <span key={String(f)}>{f}</span>
            ))}
            <Deadline app={app} />
            {app.url && (
              <a href={app.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:underline" data-testid="posting">
                posting <ExternalLink size={11} aria-hidden />
              </a>
            )}
          </p>
        </div>
        {app.fit && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${app.fitKnown ? fitLook[app.fit] : 'bg-amber-100 text-amber-800 ring-1 ring-amber-400'}`}
            title={app.fitKnown ? 'Fit verdict' : 'Not one of strong / possible / stretch / skip'}
          >
            {app.fit}
            {!app.fitKnown && ' ⚠'}
          </span>
        )}
      </div>
      {app.notes && <p className="mt-1 text-sm whitespace-pre-line text-stone-600 dark:text-stone-400">{app.notes}</p>}
      {app.problems.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠ {app.problems.join(' · ')}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={`Status of ${app.company} ${app.title}`}
          value={app.statusKnown ? app.status : ''}
          disabled={busy}
          onChange={(e) => onStatus(e.target.value as AppStatus)}
          className={`h-8 rounded-md border px-1.5 text-sm ${app.statusKnown ? statusLook[app.status as AppStatus] : 'border-amber-400'}`}
        >
          {!app.statusKnown && (
            <option value="" disabled>
              "{app.status}" (not a status)
            </option>
          )}
          {APP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <Action small disabled={!app.files.resume} title={app.files.resume ? 'Open resume.pdf in Preview' : 'No resume.pdf in this packet'} onClick={() => run({ kind: 'packet-file', slug, id: app.id, file: 'resume' })}>
          Resume PDF
        </Action>
        <Action
          small
          disabled={!app.files.coverLetter}
          title={app.files.coverLetter ? 'Open cover_letter.pdf in Preview' : 'No cover_letter.pdf in this packet'}
          onClick={() => run({ kind: 'packet-file', slug, id: app.id, file: 'cover-letter' })}
        >
          Cover letter PDF
        </Action>
        {app.files.fillSheet && (
          <Action small onClick={onOpen}>
            <span className="inline-flex items-center gap-1">
              <FileText size={13} aria-hidden /> Fill sheet
            </span>
          </Action>
        )}
      </div>
    </li>
  );
}

export function ApplicationsSection({ project, run }: SectionProps) {
  const slug = project.slug;
  const queryClient = useQueryClient();
  const queue = useQuery({ queryKey: ['applications', slug], queryFn: () => fetchQueue(slug) });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [showing, setShowing] = useState<Application | null>(null);
  const change = useMutation({
    mutationFn: ({ app, status, version }: { app: Application; status: AppStatus; version: string }) => setApplicationStatus(slug, app, status, version),
    onSuccess: (q, { app, status }) => {
      queryClient.setQueryData(['applications', slug], q);
      setNotice({ ok: true, text: `Saved: ${app.company} · ${app.title} is now ${status}.` });
    },
    onError: (e: Error) => {
      setNotice({ ok: false, text: e.message });
      const current = e instanceof HubError && e.status === 409 ? (e.body.current as Queue | null) : null;
      if (current) queryClient.setQueryData(['applications', slug], current);
      else void queryClient.invalidateQueries({ queryKey: ['applications', slug] });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const q = queue.data;
  if (queue.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (queue.error) return <p className="text-sm text-red-600">{queue.error.message}</p>;
  if (!q) return null;
  if (!queueOk(q)) return <p className="text-sm text-red-600">{'error' in q ? q.error : "review_queue.yaml can't be read"}</p>;

  const sorted = sortApplications(q.items);
  const groups = [...APP_STATUSES, 'other'].map((s) => ({ status: s, items: sorted.filter((a) => (s === 'other' ? !a.statusKnown : a.status === s)) })).filter((g) => g.items.length);
  return (
    <div className="space-y-3" data-testid="applications">
      <p className="text-sm">
        <strong>{queueSummary(q.counts)}</strong>
        <span className="text-stone-500"> · from {shortenHome(q.file)}</span>
      </p>
      {notice && (
        <p className={`rounded-md px-3 py-2 text-sm ${notice.ok ? 'bg-stone-100 text-stone-700 dark:bg-stone-900 dark:text-stone-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}>{notice.text}</p>
      )}
      {q.problems.map((p) => (
        <p key={p} className="text-xs text-amber-700">
          {p}
        </p>
      ))}
      {q.items.length === 0 && <p className="text-sm text-stone-500">The queue is empty. Career HQ adds a draft here each time it builds a packet.</p>}
      {groups.map((g) => (
        <div key={g.status}>
          <h3 className="mb-1.5 text-xs font-medium tracking-wide text-stone-500 uppercase">
            {g.status === 'other' ? 'Unknown status' : g.status} ({g.items.length})
          </h3>
          <ul className="space-y-2">
            {g.items.map((app) => (
              <Card
                key={`${app.index}:${app.id}`}
                app={app}
                slug={slug}
                run={run}
                busy={change.isPending}
                onStatus={(status) => change.mutate({ app, status, version: q.version })}
                onOpen={() => setShowing(app)}
              />
            ))}
          </ul>
        </div>
      ))}
      {showing && <FillSheetModal slug={slug} app={showing} onClose={() => setShowing(null)} />}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState<boolean | 'failed'>(false);
  const copy = () =>
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied('failed'),
    );
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-stone-300 px-2 text-xs hover:border-stone-500 dark:border-stone-700"
    >
      {copied === true ? <Check size={12} className="text-green-600" aria-hidden /> : <Copy size={12} aria-hidden />}
      {copied === true ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

function Part({ part }: { part: FillPart }) {
  switch (part.type) {
    case 'heading':
      return part.level <= 2 ? (
        <h3 className="mt-5 border-b border-stone-200 pb-1 text-sm font-semibold dark:border-stone-800">{part.text}</h3>
      ) : (
        <h4 className={`mt-3 ${part.level === 3 ? 'text-sm font-medium' : 'text-xs font-medium text-stone-600 dark:text-stone-400'}`}>{part.text}</h4>
      );
    case 'note':
      return <p className="rounded-md bg-amber-50 px-2 py-1 text-xs whitespace-pre-line text-amber-800 dark:bg-amber-950 dark:text-amber-300">{part.text}</p>;
    case 'text':
      return <p className="text-xs whitespace-pre-line text-stone-500">{part.text.replace(/`/g, '')}</p>;
    case 'field':
      return (
        <div className="flex items-start gap-2 py-1" data-testid="fill-field">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-stone-500">
              {part.label}
              {part.hint && <span className="ml-1 text-stone-400">{part.hint}</span>}
            </p>
            <pre className={`font-sans text-sm break-words whitespace-pre-wrap ${part.missing ? 'text-stone-400 italic' : ''}`}>{part.value || '(blank)'}</pre>
          </div>
          {!part.missing && <CopyButton value={part.value} label={part.label} />}
        </div>
      );
  }
}

function FillSheetModal({ slug, app, onClose }: { slug: string; app: Application; onClose: () => void }) {
  const sheet = useQuery({ queryKey: ['fill-sheet', slug, app.id], queryFn: () => fetchFillSheet(slug, app.id), staleTime: Infinity });
  return (
    <Modal title={`Fill sheet · ${app.company} · ${app.title}`} onClose={onClose} wide>
      <div className="-mt-2 max-h-[75vh] space-y-1 overflow-y-auto pr-1" data-testid="fill-sheet">
        {sheet.isPending && <p className="text-sm text-stone-500">Loading…</p>}
        {sheet.error && <p className="text-sm text-red-600">{sheet.error.message}</p>}
        {sheet.data?.parts.map((p, i) => <Part key={i} part={p} />)}
      </div>
      <div className="mt-4 flex justify-end">
        <Action onClick={onClose}>Close</Action>
      </div>
    </Modal>
  );
}

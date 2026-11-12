// Applications: Career HQ's review queue (jobs/queue.yaml; Career HQ owns it).
// One card per application, drafts first and then by deadline. Changing a
// status runs Career HQ's own command (`uv run python scripts/review_queue.py
// status …`) through the hub; if it fails, its output and the command to copy
// are shown. Submitted cards get outcome buttons (No response, Rejected,
// Interview, Offer, Pending) that run Career HQ's `review_queue.py outcome`,
// and the Submitted group opens with a fit tag × outcome table counted from
// the queue. Clicking a card shows its fill sheet (fill_sheet.json, or
// fill_sheet.md) with a Copy button on every field except notes and missing
// values, and character counts against any limit. A pending shorter draft that
// fits gets an Approve button, which runs Career HQ's approve-draft with the
// SHA-256 of the draft as shown. Open letter in Word, Open resume in Word,
// Rebuild PDF (a resume edited after its PDF) and Fill application (reviewed
// packets only) run Career HQ's open-letter, open-resume, resume_state.py pdf
// and launch-apply; launch-apply opens a Terminal window running Claude Code's
// /apply, which stops before submit. "Add a job" takes a link or pasted posting
// text (plus an optional link) and runs Career HQ's launch-manual, which opens
// Claude Code's /build-packet in Terminal. Everything is read from local disk by the hub.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { createContext, useContext, useState, type MouseEvent } from 'react';
import {
  APP_STATUSES,
  FIT_LABELS,
  fitLabel,
  limitFlags,
  limitSummary,
  manualJobInput,
  MANUAL_MAX_TEXT_BYTES,
  OUTCOME_CHOICES,
  OUTCOME_LABELS,
  outcomeTable,
  queueSummary,
  sha256Hex,
  sortApplications,
  utf8Bytes,
  type AppStatus,
  type OutcomeChoice,
} from '../../../src/server/queue-rules.ts';
import { approveShorterDraft, fetchPdfCheck, launchManualJob, type DocCheck, fetchFillSheet, fetchQueue, HubError, queueOk, setApplicationOutcome, setApplicationStatus, type Application, type CareerLaunchKind, type FieldCount, type FillPart, type ShorterDraft, type ShownQueue } from '../api.ts';
import { Action, Modal, shortenHome } from '../ui.tsx';
import { careerKey, careerRepo, quoteArg, useCareerBusy, useCareerLaunch, WHAT } from './career-launch.ts';
import type { SectionProps } from './sections.tsx';

const statusLook: Record<AppStatus, string> = {
  draft: 'border-stone-300 dark:border-stone-700',
  reviewed: 'border-sky-400 bg-sky-50 dark:bg-sky-950',
  submitted: 'border-green-500 bg-green-50 dark:bg-green-950',
};

// Amber is kept for "unknown value" flags, so no tag uses it.
const fitLook: Record<string, string> = {
  strong: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  reach: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  long_shot: 'bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
};
const FIT_NAMES = Object.values(FIT_LABELS).join(' / ');

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

type CardProps = {
  app: Application;
  slug: string;
  repo: string;
  run: SectionProps['run'];
  busy: boolean;
  /** Which Career HQ launch is running for this card, if any. */
  launching: CareerLaunchKind | null;
  /** The outcome being recorded for this card right now, if any. */
  recording: OutcomeChoice | null;
  onStatus: (s: AppStatus) => void;
  onOutcome: (o: OutcomeChoice) => void;
  onLaunch: (kind: CareerLaunchKind) => void;
  onOpen: () => void;
};

function Card({ app, slug, repo, run, busy, launching, recording, onStatus, onOutcome, onLaunch, onOpen }: CardProps) {
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, select, input')) return;
    if (app.files.fillSheet) onOpen();
  };
  // Career HQ's own check (the one /apply runs before each upload) says whether each PDF is current.
  const pdfs = useQuery({ queryKey: ['pdf-check', slug, app.id], queryFn: () => fetchPdfCheck(slug, app.id), enabled: app.files.resumeDocx || app.files.coverLetterDocx });
  const checked = pdfs.data && !('error' in pdfs.data) ? pdfs.data : null;
  const checkError = pdfs.data && 'error' in pdfs.data ? pdfs.data.error : pdfs.error?.message;
  const resumeStale = !!checked?.resume && checked.resume.state !== 'current';
  const letterStale = !!checked?.letter && checked.letter.state !== 'current';
  const facts = [app.location, app.added && `added ${fmtDate(app.added)}`, app.status === 'submitted' && app.submittedOn && `submitted ${fmtDate(app.submittedOn)}`].filter(Boolean);
  return (
    <li
      id={cardId(app.id)}
      data-testid="application"
      data-status={app.status}
      onClick={open}
      className={`rounded-lg border border-stone-200 p-3 dark:border-stone-800 ${app.files.fillSheet ? 'cursor-pointer hover:border-stone-400 dark:hover:border-stone-600' : ''}`}
      title={app.files.fillSheet ? 'Show the fill sheet' : 'No fill_sheet.json or fill_sheet.md in this packet'}
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
            title={app.fitKnown ? "Career HQ's fit check tag" : `"${app.fit}" isn't one of ${FIT_NAMES}`}
            data-testid="fit"
          >
            {fitLabel(app.fit)}
            {!app.fitKnown && ' ⚠'}
          </span>
        )}
      </div>
      {app.notes && <p className="mt-1 text-sm whitespace-pre-line text-stone-600 dark:text-stone-400">{app.notes}</p>}
      {app.status === 'submitted' && <OutcomeButtons app={app} busy={busy} recording={recording} onOutcome={onOutcome} />}
      {app.problems.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠ {app.problems.join(' · ')}</p>}
      {letterStale && <LetterNotSynced app={app} repo={repo} doc={checked!.letter!} />}
      {resumeStale && <ResumePdfOutdated app={app} repo={repo} doc={checked!.resume!} busy={busy} launching={launching} onLaunch={onLaunch} />}
      {checkError && (
        <p className="mt-1 text-xs text-stone-500" data-testid="pdf-check-error">
          Couldn't check the PDFs with Career HQ: {checkError}
        </p>
      )}
      {(app.resume === 'edited' || app.resume === 'edited_pdf_outdated') && !resumeStale && (
        <p className="mt-1 text-xs text-stone-500" data-testid="resume-edited">
          Resume edited in Word · rebuilds keep your edits
        </p>
      )}
      {app.limits && limitSummary(app.limits) && (
        <p className={`mt-1 text-xs font-medium ${app.limits.over ? 'text-red-600 dark:text-red-400' : 'text-violet-700 dark:text-violet-300'}`} data-testid="limit-flags">
          ⚠ Fill sheet: {limitSummary(app.limits)}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={`Status of ${app.company} ${app.title}`}
          title="Runs Career HQ's status command"
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
        {app.status === 'reviewed' && (
          <Action
            small
            primary
            disabled={busy}
            title={'Runs Career HQ\'s launch-apply: a new Terminal window running Claude Code\'s /apply, which fills the form in Chrome and stops before submit. You submit it yourself.'}
            onClick={() => onLaunch('launch-apply')}
          >
            {launching === 'launch-apply' ? 'Opening Terminal…' : 'Fill application'}
          </Action>
        )}
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
        {app.files.resumeDocx && (
          <Action small disabled={busy} title="Runs Career HQ's open-resume: opens resume.docx in Microsoft Word (changes no file)" onClick={() => onLaunch('open-resume')}>
            {launching === 'open-resume' ? 'Opening…' : 'Open resume in Word'}
          </Action>
        )}
        {app.files.coverLetterDocx && (
          <Action small disabled={busy} title="Runs Career HQ's open-letter: opens cover_letter.docx in Microsoft Word (changes no file)" onClick={() => onLaunch('open-letter')}>
            {launching === 'open-letter' ? 'Opening…' : 'Open letter in Word'}
          </Action>
        )}
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

/**
 * What happened after submitting: one button per outcome, the current one
 * pressed. Each runs Career HQ's `review_queue.py outcome <id> <value>`
 * (Pending clears it); the card then shows the queue as Career HQ rewrote it.
 */
function OutcomeButtons({ app, busy, recording, onOutcome }: { app: Application; busy: boolean; recording: OutcomeChoice | null; onOutcome: (o: OutcomeChoice) => void }) {
  // An unknown outcome presses nothing (the card's problem line flags it).
  const current: OutcomeChoice | null = !app.outcomeKnown ? null : ((app.outcome as OutcomeChoice | null) ?? 'pending');
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="outcome">
      <span className="text-stone-500">Outcome:</span>
      <div role="group" aria-label={`Outcome of ${app.company} ${app.title}`} className="inline-flex overflow-hidden rounded-md border border-stone-300 dark:border-stone-700">
        {OUTCOME_CHOICES.map((o) => {
          const on = current === o;
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              disabled={busy}
              title={o === 'pending' ? "Clears the outcome (Career HQ's outcome command)" : "Runs Career HQ's outcome command"}
              onClick={() => !on && onOutcome(o)}
              className={`border-l border-stone-300 px-2 py-1 first:border-l-0 disabled:opacity-60 dark:border-stone-700 ${
                on ? 'bg-stone-800 font-medium text-white dark:bg-stone-200 dark:text-stone-900' : 'hover:bg-stone-100 dark:hover:bg-stone-800'
              }`}
            >
              {recording === o ? <Loader2 size={12} className="inline animate-spin" aria-label="Saving" /> : OUTCOME_LABELS[o]}
            </button>
          );
        })}
      </div>
      {app.outcome && app.outcomeOn && <span className="text-stone-500">recorded {fmtDate(app.outcomeOn)}</span>}
    </div>
  );
}

/** Submitted applications by fit tag and outcome, counted from the queue (the same counts as Career HQ's `review_queue.py outcomes`). */
function OutcomeTableView({ items }: { items: Application[] }) {
  const t = outcomeTable(items);
  if (t.total === 0 && t.unknown === 0) return null;
  const cell = (n: number) => <td className={`px-2 py-0.5 text-right tabular-nums ${n ? '' : 'text-stone-400 dark:text-stone-600'}`}>{n}</td>;
  return (
    <div className="mb-2 overflow-x-auto rounded-md border border-stone-200 p-2 dark:border-stone-800" data-testid="outcome-table">
      <table className="text-xs">
        <caption className="mb-1 text-left text-stone-500">Outcome by fit tag (submitted only)</caption>
        <thead>
          <tr className="text-stone-500">
            <th className="px-2 py-0.5 text-left font-medium">Fit</th>
            {OUTCOME_CHOICES.map((o) => (
              <th key={o} className="px-2 py-0.5 text-right font-medium">
                {OUTCOME_LABELS[o]}
              </th>
            ))}
            <th className="px-2 py-0.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.fit ?? 'none'} className="border-t border-stone-100 dark:border-stone-900">
              <th className="px-2 py-0.5 text-left font-normal">{r.fit ? FIT_LABELS[r.fit] : 'No tag'}</th>
              {OUTCOME_CHOICES.map((o) => cell(r.counts[o]))}
              <td className="px-2 py-0.5 text-right font-medium tabular-nums">{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {t.unknown > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠ {t.unknown} with an unknown outcome {t.unknown === 1 ? "isn't" : "aren't"} counted.</p>}
    </div>
  );
}

export function ApplicationsSection({ project, run }: SectionProps) {
  const slug = project.slug;
  const queryClient = useQueryClient();
  const queue = useQuery({ queryKey: ['applications', slug], queryFn: () => fetchQueue(slug) });
  const [notice, setNotice] = useState<NoticeValue | null>(null);
  const [showing, setShowing] = useState<Application | null>(null);
  const change = useMutation({
    mutationKey: careerKey(slug),
    mutationFn: ({ app, status, version }: { app: Application; status: AppStatus; version: string }) => setApplicationStatus(slug, app.id, status, version),
    onMutate: () => setNotice(null),
    onSuccess: (r, { app, status }) => {
      queryClient.setQueryData(['applications', slug], r.queue);
      setNotice({ ok: true, text: `Done: ${app.company} · ${app.title} is now ${status} (Career HQ's status command).` });
    },
    onError: (e: Error, { status }) => {
      const body = e instanceof HubError ? e.body : {};
      const current = e instanceof HubError && e.status === 409 ? ((body.current as ShownQueue | undefined) ?? null) : null;
      setNotice({
        ok: false,
        text: current ? e.message : `Couldn't change it to ${status}: ${e.message}`,
        output: typeof body.output === 'string' && body.output ? body.output : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
      });
      // The control goes back to what the queue says.
      if (current) queryClient.setQueryData(['applications', slug], current);
      else void queryClient.invalidateQueries({ queryKey: ['applications', slug] });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  // Outcome buttons: Career HQ's `review_queue.py outcome`; the card then shows the queue the server re-read.
  const record = useMutation({
    mutationKey: careerKey(slug),
    mutationFn: ({ app, outcome, version }: { app: Application; outcome: OutcomeChoice; version: string }) => setApplicationOutcome(slug, app.id, outcome, version),
    onMutate: () => setNotice(null),
    onSuccess: (r) => {
      queryClient.setQueryData(['applications', slug], r.queue);
      setNotice({ ok: true, text: r.message });
    },
    onError: (e: Error, { app, outcome }) => {
      const body = e instanceof HubError ? e.body : {};
      const current = e instanceof HubError && e.status === 409 ? ((body.current as ShownQueue | undefined) ?? null) : null;
      setNotice({
        ok: false,
        text: current ? e.message : `Couldn't record ${OUTCOME_LABELS[outcome]} for ${app.company} · ${app.title}: ${e.message}`,
        output: typeof body.output === 'string' && body.output ? body.output : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
      });
      if (current) queryClient.setQueryData(['applications', slug], current);
    },
    // Read the file again either way: Career HQ rewrote it (or refused), and nothing retries.
    onSettled: () => {
      for (const key of ['applications', 'projects']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });

  const launch = useCareerLaunch(slug, setNotice);
  const busy = useCareerBusy(slug);

  const q = queue.data;
  if (queue.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (queue.error) return <p className="text-sm text-red-600">{queue.error.message}</p>;
  if (!q) return null;
  if (!queueOk(q)) return <p className="text-sm text-red-600">{'error' in q ? q.error : "The review queue can't be read"}</p>;

  const sorted = sortApplications(q.items);
  const groups = [...APP_STATUSES, 'other'].map((s) => ({ status: s, items: sorted.filter((a) => (s === 'other' ? !a.statusKnown : a.status === s)) })).filter((g) => g.items.length);
  return (
    <div className="space-y-3" data-testid="applications">
      <p className="text-sm">
        <strong>{queueSummary(q.counts)}</strong>
        <span className="text-stone-500"> · from {shortenHome(q.file)}</span>
      </p>
      {q.others.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          ⚠ Also found {q.others.map(shortenHome).join(', ')}; showing the newer {shortenHome(q.file)}.
        </p>
      )}
      {change.isPending && (
        <p className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-900 dark:text-stone-300" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Running Career HQ's status command…
        </p>
      )}
      {record.isPending && (
        <p className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-900 dark:text-stone-300" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Running Career HQ's outcome command…
        </p>
      )}
      {launch.isPending && (
        <p className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-900 dark:text-stone-300" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Running Career HQ's {launch.variables ? WHAT[launch.variables.kind] : ''} command…
        </p>
      )}
      {notice && <Notice notice={notice} />}
      <AddJob slug={slug} busy={busy} setNotice={setNotice} />
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
          {g.status === 'submitted' && <OutcomeTableView items={g.items} />}
          <ul className="space-y-2">
            {g.items.map((app) => (
              <Card
                key={`${app.index}:${app.id}`}
                app={app}
                slug={slug}
                repo={careerRepo(q.file)}
                run={run}
                busy={busy}
                launching={launch.isPending && launch.variables?.id === app.id ? launch.variables.kind : null}
                recording={record.isPending && record.variables?.app.id === app.id ? record.variables.outcome : null}
                onStatus={(status) => change.mutate({ app, status, version: q.version })}
                onOutcome={(outcome) => record.mutate({ app, outcome, version: q.version })}
                onLaunch={(kind) => launch.mutate({ kind, id: app.id, label: `${app.company} · ${app.title}` })}
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

/**
 * Career HQ's check doesn't list cover_letter.pdf as current (Word edits not
 * synced, or no PDF yet): /apply leaves the letter out until a sync.
 */
function LetterNotSynced({ app, repo, doc }: { app: Application; repo: string; doc: DocCheck }) {
  const command = `cd ${repo} && uv run python scripts/letter_sync.py sync ${quoteArg(app.id)}`;
  return (
    <div className="mt-1 space-y-1 text-xs text-amber-800 dark:text-amber-300" data-testid="letter-edited" title={doc.note ?? undefined}>
      <p>
        ⚠ {doc.state === 'no-pdf' ? 'No cover_letter.pdf yet' : "cover_letter.pdf wasn't made from cover_letter.docx as it is now (Word edits not synced)"}
        {app.status === 'reviewed' ? ', so Fill application will leave the letter out' : ''}. To sync:
      </p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-amber-50 px-2 py-1 break-all text-stone-800 dark:bg-amber-950 dark:text-stone-200">{command}</code>
        <CopyButton value={command} label="the sync command" />
      </div>
    </div>
  );
}

/**
 * "Add a job": one box for a job link or the pasted posting; with pasted text,
 * an optional "Posting link" so Career HQ can still check for a duplicate. The
 * text stays in this component's memory only (never saved in the browser) and
 * is cleared once Career HQ has taken it.
 */
function AddJob({ slug, busy, setNotice }: { slug: string; busy: boolean; setNotice: (n: NoticeValue | null) => void }) {
  const queryClient = useQueryClient();
  const [box, setBox] = useState('');
  const [link, setLink] = useState('');
  const job = manualJobInput(box, link);
  const build = useMutation({
    mutationKey: careerKey(slug),
    mutationFn: () => launchManualJob(slug, { url: job.url, text: job.text }),
    onMutate: () => setNotice(null),
    onSuccess: (r) => {
      setBox('');
      setLink('');
      setNotice({ ok: true, text: `${r.message}. Watch it in that Terminal window; press Ctrl+C or close the window to stop it.` });
    },
    onError: (e: Error) => {
      const body = e instanceof HubError ? e.body : {};
      setNotice({
        ok: false,
        text: `Add a job: ${e.message}`,
        output: typeof body.output === 'string' && body.output ? body.output : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
        duplicate: isDuplicate(body.duplicate) ? body.duplicate : undefined,
      });
    },
    onSettled: () => {
      for (const key of ['applications', 'projects']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
  const bytes = job.mode === 'text' ? utf8Bytes(box) : 0;
  return (
    <form
      className="space-y-1.5 rounded-lg border border-dashed border-stone-300 p-3 dark:border-stone-700"
      data-testid="add-job"
      onSubmit={(e) => {
        e.preventDefault();
        if (job.mode !== 'empty' && !job.problem && !busy) build.mutate();
      }}
    >
      <label htmlFor={`add-job-${slug}`} className="text-sm font-medium">
        Add a job
      </label>
      <textarea
        id={`add-job-${slug}`}
        value={box}
        onChange={(e) => setBox(e.target.value)}
        rows={job.mode === 'text' ? 6 : 2}
        placeholder="Paste a job link (https://…) or the whole posting text"
        className="block w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-stone-700 dark:bg-stone-950"
        spellCheck={false}
      />
      {job.mode === 'link' && !job.problem && <p className="text-xs text-stone-500">Link · Career HQ checks it isn't already a packet, then opens it in Chrome to read the posting.</p>}
      {job.mode === 'text' && (
        <>
          <p className={`text-xs ${bytes > MANUAL_MAX_TEXT_BYTES ? 'text-red-600 dark:text-red-400' : 'text-stone-500'}`}>
            Pasted posting · {bytes.toLocaleString()} / {MANUAL_MAX_TEXT_BYTES.toLocaleString()} bytes
          </p>
          <label className="block text-xs text-stone-600 dark:text-stone-400">
            Posting link (optional)
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://…"
              className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-950"
            />
            <span className="text-stone-500">Lets Career HQ check for an existing packet. The page isn't opened; your pasted text is the posting.</span>
          </label>
        </>
      )}
      {job.problem && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {job.problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Action small primary type="submit" disabled={busy || job.mode === 'empty' || !!job.problem} title="Runs Career HQ's launch-manual: a new Terminal window running Claude Code's /build-packet for this job">
          {build.isPending ? 'Opening Terminal…' : 'Build packet'}
        </Action>
        <span className="text-xs text-stone-500">Opens Claude Code in Terminal. It uses your Claude plan's usage, like the feed's Build packet, and stops at draft for your review.</span>
      </div>
    </form>
  );
}

/**
 * Career HQ's check doesn't list resume.pdf as current (Word edits since, or no PDF yet), so Fill application
 * leaves the resume out. Rebuild PDF runs Career HQ's resume_state.py pdf (Word
 * saves the PDF); the command to copy stays as the fallback.
 */
function ResumePdfOutdated({ app, repo, doc, busy, launching, onLaunch }: { app: Application; repo: string; doc: DocCheck; busy: boolean; launching: CareerLaunchKind | null; onLaunch: (kind: CareerLaunchKind) => void }) {
  const command = `cd ${repo} && uv run python scripts/resume_state.py pdf ${quoteArg(app.id)}`;
  return (
    <div className="mt-1 space-y-1 text-xs text-amber-800 dark:text-amber-300" data-testid="resume-pdf-outdated" title={doc.note ?? undefined}>
      <p>
        ⚠ {doc.state === 'no-pdf' ? 'No resume.pdf yet' : "resume.pdf wasn't made from resume.docx as it is now (Word edits since)"}
        {app.status === 'reviewed' ? ', so Fill application will leave the resume out' : ''}. Close the resume in Word, then:
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <Action small disabled={busy} title="Runs Career HQ's resume_state.py pdf: Word saves resume.pdf from your edited resume.docx" onClick={() => onLaunch('resume-pdf')}>
          {launching === 'resume-pdf' ? 'Rebuilding…' : 'Rebuild PDF'}
        </Action>
        <span className="self-center">or run it yourself:</span>
      </div>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-amber-50 px-2 py-1 break-all text-stone-800 dark:bg-amber-950 dark:text-stone-200">{command}</code>
        <CopyButton value={command} label="the PDF command" />
      </div>
    </div>
  );
}

/** The packet Career HQ said a link already has (Add a job), as the queue lists it. */
type Duplicate = { id: string; company: string; title: string };
const isDuplicate = (v: unknown): v is Duplicate =>
  !!v && typeof v === 'object' && ['id', 'company', 'title'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string');

/** The DOM id of an application's card, to jump to it. */
const cardId = (id: string) => `application-${id}`;

/** Scrolls to an application's card and outlines it for a moment. */
function showCard(id: string) {
  const el = document.getElementById(cardId(id));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const ring = ['ring-2', 'ring-sky-500', 'ring-offset-2'];
  el.classList.add(...ring);
  setTimeout(() => el.classList.remove(...ring), 2000);
}

export type NoticeValue = { ok: boolean; text: string; output?: string; command?: string; duplicate?: Duplicate };

export function Notice({ notice }: { notice: NoticeValue }) {
  if (notice.ok) return <p className="rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-900 dark:text-stone-300">{notice.text}</p>;
  return (
    <div className="space-y-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="alert" data-testid="status-failed">
      <p>{notice.text}</p>
      {notice.duplicate && (
        <p>
          <button type="button" className="font-medium underline hover:no-underline" data-testid="duplicate-link" onClick={() => showCard(notice.duplicate!.id)}>
            Go to {notice.duplicate.company} · {notice.duplicate.title} ↓
          </button>
        </p>
      )}
      {notice.output && <pre className="max-h-48 overflow-auto rounded bg-white/70 p-2 text-xs whitespace-pre-wrap text-stone-800 dark:bg-black/30 dark:text-stone-200">{notice.output}</pre>}
      {notice.command && (
        <div>
          <p className="text-xs">Or run it yourself in Terminal:</p>
          <div className="mt-1 flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded bg-white/70 px-2 py-1 text-xs break-all text-stone-800 dark:bg-black/30 dark:text-stone-200">{notice.command}</code>
            <CopyButton value={notice.command} label="the command" />
          </div>
        </div>
      )}
    </div>
  );
}

export function CopyButton({ value, label, anyway = false }: { value: string; label: string; anyway?: boolean }) {
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
      aria-label={anyway ? `Copy ${label} anyway (over the limit)` : `Copy ${label}`}
      title={anyway ? "Over the form's limit: copy it only to trim it yourself" : undefined}
      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs whitespace-nowrap ${anyway ? 'border-red-400 text-red-700 hover:border-red-600 dark:border-red-700 dark:text-red-300' : 'border-stone-300 hover:border-stone-500 dark:border-stone-700'}`}
    >
      {copied === true ? <Check size={12} className="text-green-600" aria-hidden /> : <Copy size={12} aria-hidden />}
      {copied === true ? 'Copied' : copied === 'failed' ? 'Copy failed' : anyway ? 'Copy anyway' : 'Copy'}
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
    case 'field': {
      const over = !!part.count?.over;
      return (
        <div
          className={`flex items-start gap-2 py-1 ${over ? 'my-1 rounded-md border border-red-300 bg-red-50/60 px-2 py-2 dark:border-red-900 dark:bg-red-950/40' : ''}`}
          data-testid="fill-field"
          data-flag={over || part.draft ? '' : undefined}
        >
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-stone-500">
              <span>
                {part.label}
                {part.hint && <span className="ml-1 text-stone-400">{part.hint}</span>}
              </span>
              {part.count && <CharCount count={part.count} />}
            </p>
            {part.missing ? (
              <p className="mt-0.5 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300" data-testid="fill-missing" title={part.value}>
                <AlertTriangle size={13} aria-hidden /> Not in your profile; fill this in yourself.
              </p>
            ) : (
              <pre className="font-sans text-sm break-words whitespace-pre-wrap">{part.value || '(blank)'}</pre>
            )}
            {over && part.count && (
              <div className="mt-1.5 space-y-0.5 text-xs text-red-700 dark:text-red-300" data-testid="over-limit" role="note">
                <p className="flex items-center gap-1 font-medium">
                  <AlertTriangle size={13} aria-hidden />
                  {part.count.max !== null && part.count.length > part.count.max
                    ? `Over the limit by ${part.count.length - part.count.max} characters (${part.count.length} / ${part.count.max}). Don't paste this as-is.`
                    : "Career HQ marks this over the form's limit. Don't paste this as-is."}
                </p>
                {!part.draft && <p>No shorter version drafted yet. Ask Career HQ for one (same facts, fewer words).</p>}
              </div>
            )}
            {part.draft && <DraftBox draft={part.draft} />}
          </div>
          {!part.missing && <CopyButton value={part.value} label={part.label} anyway={over} />}
        </div>
      );
    }
  }
}

/** A pending shorter draft: a suggestion with its own count. No Copy button; Career HQ makes it the value once approved. */
/** Approving drafts in the open fill sheet: one at a time, every button disabled while one runs. */
const ApproveContext = createContext<{ approve: (d: ShorterDraft) => void; running: number | null } | null>(null);

function DraftBox({ draft }: { draft: ShorterDraft }) {
  const { count } = draft;
  const fits = count.max !== null && !count.over;
  const approval = useContext(ApproveContext);
  // Only drafts Career HQ numbered (JSON) and that fit a known limit can be approved here.
  const approvable = fits && draft.question !== null && approval !== null;
  return (
    <div className="mt-2 rounded-md border border-dashed border-violet-400 bg-violet-50/70 px-2.5 py-2 dark:border-violet-700 dark:bg-violet-950/40" data-testid="shorter-draft">
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-violet-800 dark:text-violet-300">
        <span>Shorter draft, pending your approval</span>
        <span className={`tabular-nums ${count.over ? 'text-red-600 dark:text-red-400' : ''}`} data-testid="draft-count">
          {count.max !== null ? `${count.length} / ${count.max}` : `${count.length} chars`}
          {fits && ' ✓'}
          {count.over && count.max !== null && ` · still over by ${count.length - count.max}`}
          {count.over && count.max === null && ' · still over the limit'}
        </span>
      </p>
      <p className="mt-1 text-sm break-words whitespace-pre-wrap text-stone-800 select-text dark:text-stone-200">{draft.value}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <p className="flex-1 text-xs text-violet-700/80 dark:text-violet-300/80">
          {approvable ? 'Not approved yet. Approve makes it the value (Career HQ keeps the old answer).' : count.over ? 'Not approved yet, and still too long to approve.' : 'Not approved yet. Approve it in Career HQ to make it the value.'}
        </p>
        {approvable && (
          <button
            type="button"
            data-testid="approve-draft"
            disabled={approval.running !== null}
            onClick={() => approval.approve(draft)}
            title="Runs Career HQ's approve-draft command"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-violet-700 px-2.5 text-xs font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-600 dark:hover:bg-violet-500"
          >
            {approval.running === draft.question ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Check size={12} aria-hidden />}
            {approval.running === draft.question ? 'Approving…' : 'Approve'}
          </button>
        )}
      </div>
    </div>
  );
}

/** "300 chars", or "484 / 500" against the form's limit, red when over; flagged if the file's own count is stale. */
function CharCount({ count }: { count: FieldCount }) {
  const over = count.over;
  const stale = count.chars !== null && count.chars !== count.length;
  return (
    <span
      data-testid="char-count"
      data-over={over || undefined}
      className={`tabular-nums ${over ? 'font-medium text-red-600 dark:text-red-400' : 'text-stone-400'}`}
      title={over && count.max !== null ? `${count.length - count.max} characters over the form's ${count.max}-character limit` : count.max !== null ? `The form allows ${count.max} characters` : 'Character count (limit unknown)'}
    >
      {count.max !== null ? `${count.length} / ${count.max}` : `${count.length} chars`}
      {over && count.max !== null && count.length > count.max && ` · ${count.length - count.max} over`}
      {stale && <span className="ml-1 text-amber-600" title={`The fill sheet says ${count.chars}; the value has ${count.length}`}>(file says {count.chars})</span>}
      {count.overStale && <span className="ml-1 text-amber-600" title="Career HQ's over-the-limit flag doesn't match the count; the file may be stale">(over-limit flag doesn't match)</span>}
    </span>
  );
}

/** At the top of a sheet: what's over its limit and what's waiting for approval; clicking jumps to the first one. */
function LimitBanner({ parts }: { parts: FillPart[] }) {
  const flags = limitFlags(parts);
  const text = limitSummary(flags);
  if (!text) return null;
  const jump = (e: MouseEvent<HTMLButtonElement>) =>
    e.currentTarget.closest('[data-testid=fill-sheet]')?.querySelector('[data-flag]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return (
    <button
      type="button"
      onClick={jump}
      data-testid="limit-banner"
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium ${flags.over ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300' : 'bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-300'}`}
    >
      <AlertTriangle size={14} aria-hidden /> {text}
      <span className="ml-auto text-xs font-normal underline">Show</span>
    </button>
  );
}

function FillSheetModal({ slug, app, onClose }: { slug: string; app: Application; onClose: () => void }) {
  const sheet = useQuery({ queryKey: ['fill-sheet', slug, app.id], queryFn: () => fetchFillSheet(slug, app.id), gcTime: 0 });
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ ok: boolean; text: string; output?: string; command?: string } | null>(null);
  const approve = useMutation({
    mutationKey: careerKey(slug),
    // The hash is of the draft string exactly as this page received and shows it; never re-read at click time.
    mutationFn: async (d: ShorterDraft) => approveShorterDraft(slug, app.id, d.question!, await sha256Hex(d.value)),
    onMutate: () => setResult(null),
    onSuccess: (r) => setResult({ ok: true, text: r.message }),
    onError: (e: Error) => {
      const body = e instanceof HubError ? e.body : {};
      const output = typeof body.output === 'string' && body.output && !e.message.startsWith('error:') ? body.output : undefined;
      setResult({ ok: false, text: `Not approved: ${e.message}`, output, command: typeof body.command === 'string' ? body.command : undefined });
    },
    // Reload whatever happened (never retried): the sheet, the card's warning line, the home card.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['fill-sheet', slug, app.id] });
      void queryClient.invalidateQueries({ queryKey: ['applications', slug] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const running = approve.isPending ? (approve.variables?.question ?? null) : null;
  return (
    <ApproveContext.Provider value={{ approve: (d) => approve.mutate(d), running }}>
    <Modal title={`Fill sheet · ${app.company} · ${app.title}`} onClose={onClose} wide>
      <div className="-mt-2 max-h-[75vh] space-y-1 overflow-y-auto pr-1" data-testid="fill-sheet">
        {sheet.isPending && <p className="text-sm text-stone-500">Loading…</p>}
        {sheet.error && <p className="text-sm text-red-600">{sheet.error.message}</p>}
        {sheet.data && (
          <p className="text-xs text-stone-500">
            From {sheet.data.source === 'json' ? 'fill_sheet.json' : 'fill_sheet.md'}
            {sheet.data.generated && `, generated ${fmtDate(sheet.data.generated)}`}
          </p>
        )}
        {sheet.data?.warnings.map((w) => (
          <p key={w} className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300" role="alert">
            ⚠ {w}
          </p>
        ))}
        {result && (
          <div className="sticky top-0 z-10 pb-1" data-testid="approve-result">
            <Notice notice={result} />
          </div>
        )}
        {sheet.data && <LimitBanner parts={sheet.data.parts} />}
        {sheet.data?.parts.map((p, i) => <Part key={i} part={p} />)}
      </div>
      <div className="mt-4 flex justify-end">
        <Action onClick={onClose}>Close</Action>
      </div>
    </Modal>
    </ApproveContext.Provider>
  );
}

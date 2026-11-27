// Quick-add: type, press Enter, check the preview, confirm. Nothing reaches
// Google (or the task list) until you press Add. After adding, a toast offers
// Undo for 8 seconds.
//
//   Enter      → the parser reads the text (creates nothing)
//   preview    → Add (Enter) · Edit (opens the form) · Cancel (Esc)
//   form       → when the parser is off, unsure, slow or wrong; pre-filled
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ListTodo, Loader2, Pencil, Plus, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  createReminder,
  deleteEvent,
  deleteTask,
  fetchCalendarDefaults,
  parseQuickAdd,
  type CreatedDto,
  type ProjectDto,
  type ReminderDraft,
} from '../api.ts';
import { Kbd, Modal, PrimaryButton, SoftButton } from '../ui.tsx';
import { localDate, previewParts } from './model.ts';
import { onQuickAddFocus } from './focus.ts';

const FALLBACK_DEFAULTS = { eventMinutes: 30, reminderMinutes: 15, allDayReminderMinutes: 900 };

type Stage = { kind: 'idle' } | { kind: 'preview'; draft: ReminderDraft } | { kind: 'form'; draft: ReminderDraft; reason: string | null };
type Toast = { created: CreatedDto; title: string } | { undone: string } | null;

export function QuickAdd({ projects, onCreated }: { projects: ProjectDto[]; onCreated?: () => void }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [toast, setToast] = useState<Toast>(null);
  const defaults = useQuery({ queryKey: ['calendar-defaults'], queryFn: fetchCalendarDefaults }).data ?? FALLBACK_DEFAULTS;
  const names = new Map(projects.map((p) => [p.slug, p.name]));

  // ⌘K → "Add reminder" lands here.
  useEffect(() => onQuickAddFocus(() => input.current?.focus()), []);

  const parse = useMutation({
    mutationFn: parseQuickAdd,
    onSuccess: (r) => setStage(r.status === 'preview' ? { kind: 'preview', draft: r.draft } : { kind: 'form', draft: r.draft, reason: r.reason }),
    // The parse call itself failed (e.g. the hub is down): open the blank form with the text as its title.
    onError: (e: Error) => setStage({ kind: 'form', draft: { kind: 'task', title: text.trim() }, reason: e.message }),
  });

  const added = (created: CreatedDto, title: string) => {
    setStage({ kind: 'idle' });
    setText('');
    setToast({ created, title });
    void queryClient.invalidateQueries();
    onCreated?.();
    input.current?.focus();
  };
  const cancel = () => {
    setStage({ kind: 'idle' });
    input.current?.focus();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !parse.isPending && stage.kind === 'idle') parse.mutate(text.trim());
  };

  return (
    <div className="space-y-3" data-testid="quick-add-area">
      <form
        className="flex items-center gap-3 rounded-card border border-line bg-card px-4 py-3 shadow-card focus-within:border-accent"
        onSubmit={submit}
        data-testid="quick-add"
        aria-busy={parse.isPending}
      >
        {parse.isPending ? <Loader2 size={18} aria-hidden className="hub-busy shrink-0 text-accent" /> : <Plus size={18} aria-hidden className="shrink-0 text-muted" />}
        <label htmlFor="quick-add-input" className="sr-only">
          Add a reminder or task
        </label>
        <input
          ref={input}
          id="quick-add-input"
          className="h-9 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-muted focus-visible:outline-none"
          placeholder="Add a reminder or task, like 'Fidelity call Fri 3pm'"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          maxLength={500}
          aria-describedby="quick-add-hint"
        />
        <span id="quick-add-hint" className="hidden shrink-0 items-center gap-1 text-[12px] text-muted sm:flex">
          {parse.isPending ? (
            'Reading…'
          ) : (
            <>
              <Kbd>↵</Kbd> to preview
            </>
          )}
        </span>
      </form>

      {stage.kind === 'preview' && (
        <PreviewCard
          draft={stage.draft}
          parts={previewParts(stage.draft, defaults, stage.draft.project ? (names.get(stage.draft.project) ?? null) : null)}
          onAdded={added}
          onEdit={() => setStage({ kind: 'form', draft: stage.draft, reason: null })}
          onCancel={cancel}
        />
      )}
      {stage.kind === 'form' && <ReminderForm draft={stage.draft} reason={stage.reason} projects={projects} defaults={defaults} onAdded={added} onCancel={cancel} />}
      {toast && <UndoToast toast={toast} setToast={setToast} />}
    </div>
  );
}

function PreviewCard({ draft, parts, onAdded, onEdit, onCancel }: { draft: ReminderDraft; parts: string[]; onAdded: (c: CreatedDto, title: string) => void; onEdit: () => void; onCancel: () => void }) {
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => addButton.current?.focus(), []);
  const add = useMutation({ mutationFn: () => createReminder(withoutKind(draft)), onSuccess: (c) => onAdded(c, draft.title) });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  const [title, ...rest] = parts;
  return (
    <section
      className="hub-fade-up rounded-card border border-accent/40 bg-card p-4 shadow-lift"
      aria-label="Check this reminder before adding it"
      onKeyDown={onKeyDown}
      data-testid="quick-add-preview"
    >
      <div className="flex items-start gap-3">
        {draft.kind === 'task' ? <ListTodo size={18} aria-hidden className="mt-0.5 shrink-0 text-muted" /> : <CalendarPlus size={18} aria-hidden className="mt-0.5 shrink-0 text-accent" />}
        <p className="min-w-0 flex-1 text-[14px] text-ink" data-testid="preview-line">
          <span className="font-semibold">{title}</span>
          {rest.map((p, i) => (
            <span key={i}>
              <span aria-hidden className="text-muted">
                {' · '}
              </span>
              <span className="sr-only">, </span>
              {p}
            </span>
          ))}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          ref={addButton}
          type="button"
          onClick={() => add.mutate()}
          disabled={add.isPending}
          data-testid="preview-add"
          className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-white shadow-glow transition hover:brightness-110 disabled:opacity-45"
        >
          {add.isPending ? 'Adding…' : draft.kind === 'task' ? 'Add task' : 'Add to calendar'}
          <kbd aria-hidden className="rounded-[4px] bg-white/20 px-1 font-sans text-[10.5px] leading-4 font-medium">
            Enter
          </kbd>
        </button>
        <SoftButton onClick={onEdit} disabled={add.isPending}>
          <Pencil size={13} aria-hidden /> Edit
        </SoftButton>
        <SoftButton onClick={onCancel} disabled={add.isPending}>
          <X size={13} aria-hidden /> Cancel <Kbd className="ml-1">Esc</Kbd>
        </SoftButton>
      </div>
      {add.error && (
        <p role="alert" className="mt-2 text-[13px] text-red-700 dark:text-red-300" data-testid="preview-error">
          {add.error.message}
        </p>
      )}
    </section>
  );
}

const withoutKind = ({ kind: _kind, ...rest }: ReminderDraft) => rest;
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The full form: opened by Edit, or directly when the parser can't be used or isn't sure. */
export function ReminderForm({
  draft,
  reason,
  projects,
  defaults,
  onAdded,
  onCancel,
}: {
  draft: ReminderDraft;
  reason: string | null;
  projects: ProjectDto[];
  defaults: typeof FALLBACK_DEFAULTS;
  onAdded: (c: CreatedDto, title: string) => void;
  onCancel: () => void;
}) {
  const start = draft.start ? localDate(draft.start) : null;
  const end = draft.end ? localDate(draft.end) : null;
  const [kind, setKind] = useState<'event' | 'task'>(draft.kind === 'event' && start ? 'event' : 'task');
  const [title, setTitle] = useState(draft.title);
  const [date, setDate] = useState(start ? ymd(start) : ymd(new Date()));
  const [allDay, setAllDay] = useState(!!draft.allDay);
  const [time, setTime] = useState(start && !draft.allDay ? hm(start) : '09:00');
  const [endTime, setEndTime] = useState(end && !draft.allDay ? hm(end) : '');
  const [endDate, setEndDate] = useState(end && draft.allDay ? ymd(end) : '');
  const [reminder, setReminder] = useState(draft.reminderMinutes != null ? String(draft.reminderMinutes) : '');
  const [repeat, setRepeat] = useState(draft.repeat ?? '');
  const [project, setProject] = useState(draft.project ?? '');
  const weekday = WEEKDAY[(localDate(date) ?? new Date()).getDay()];
  const repeatOptions: [string, string][] = [
    ['', "Doesn't repeat"],
    ['FREQ=DAILY', 'Every day'],
    [`FREQ=WEEKLY;BYDAY=${weekday}`, 'Every week on this day'],
    ['FREQ=MONTHLY', 'Every month'],
    ['FREQ=YEARLY', 'Every year'],
  ];
  // A rule the parser found that isn't one of the simple choices stays selectable.
  if (repeat && !repeatOptions.some(([v]) => v === repeat)) repeatOptions.push([repeat, `Custom (${repeat})`]);

  const body = (): Omit<ReminderDraft, 'kind'> =>
    kind === 'task'
      ? { title: title.trim(), project: project || null }
      : {
          title: title.trim(),
          start: allDay ? date : `${date}T${time}`,
          end: allDay ? (endDate && endDate > date ? endDate : null) : endTime ? `${date}T${endTime}` : null,
          allDay,
          reminderMinutes: reminder === '' ? null : Number(reminder),
          repeat: repeat || null,
          project: project || null,
        };
  const add = useMutation({ mutationFn: () => createReminder(body()), onSuccess: (c) => onAdded(c, title.trim()) });
  const field = 'mt-1 h-8 w-full min-w-0 rounded-btn border border-control bg-card px-2.5 text-[13px] text-ink focus-visible:border-accent';
  const label = 'block text-[12px] font-medium text-ink';

  return (
    <Modal title={kind === 'task' ? 'Add a task' : 'Add to calendar'} onClose={onCancel}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) add.mutate();
        }}
        data-testid="reminder-form"
      >
        {reason && (
          <p className="rounded-btn bg-warn-bg px-3 py-2 text-[13px] text-ink" data-testid="form-reason">
            {reason}
          </p>
        )}
        <div>
          <label htmlFor="rf-title" className={label}>
            Title
          </label>
          <input id="rf-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} autoFocus />
        </div>
        <fieldset>
          <legend className={label}>Kind</legend>
          <div className="mt-1 flex gap-4 text-[13px]">
            {(['event', 'task'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name="rf-kind" checked={kind === k} onChange={() => setKind(k)} className="accent-[var(--color-accent)]" />
                {k === 'event' ? 'Calendar event' : 'Task (no date)'}
              </label>
            ))}
          </div>
        </fieldset>
        {kind === 'event' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rf-date" className={label}>
                  Date
                </label>
                <input id="rf-date" type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <label className="mt-6 flex items-center gap-1.5 text-[13px] text-ink">
                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[var(--color-accent)]" />
                All day
              </label>
            </div>
            {allDay ? (
              <div>
                <label htmlFor="rf-enddate" className={label}>
                  Last day <span className="font-normal text-muted">(optional)</span>
                </label>
                <input id="rf-enddate" type="date" className={field} value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="rf-time" className={label}>
                    Starts
                  </label>
                  <input id="rf-time" type="time" className={field} value={time} onChange={(e) => setTime(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="rf-endtime" className={label}>
                    Ends <span className="font-normal text-muted">({defaults.eventMinutes} min if empty)</span>
                  </label>
                  <input id="rf-endtime" type="time" className={field} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rf-reminder" className={label}>
                  Reminder, minutes before
                </label>
                <input
                  id="rf-reminder"
                  type="number"
                  min={0}
                  max={40320}
                  className={field}
                  placeholder={String(allDay ? defaults.allDayReminderMinutes : defaults.reminderMinutes)}
                  value={reminder}
                  onChange={(e) => setReminder(e.target.value)}
                  aria-describedby="rf-reminder-help"
                />
                <p id="rf-reminder-help" className="mt-0.5 text-[11px] text-muted">
                  {allDay ? 'Counted back from midnight: 900 is 9:00 AM the day before.' : 'Empty uses the default from Settings.'}
                </p>
              </div>
              <div>
                <label htmlFor="rf-repeat" className={label}>
                  Repeats
                </label>
                <select id="rf-repeat" className={field} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                  {repeatOptions.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}
        <div>
          <label htmlFor="rf-project" className={label}>
            Project
          </label>
          <select id="rf-project" className={field} value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">No project</option>
            {projects.filter((p) => !p.archived).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {add.error && (
          <p role="alert" className="text-[13px] text-red-700 dark:text-red-300" data-testid="form-error">
            {add.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <SoftButton onClick={onCancel}>Cancel</SoftButton>
          <PrimaryButton onClick={() => title.trim() && add.mutate()} disabled={!title.trim() || add.isPending} testId="form-add">
            {add.isPending ? 'Adding…' : kind === 'task' ? 'Add task' : 'Add to calendar'}
          </PrimaryButton>
        </div>
        {/* Enter in a field submits the form. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          Add
        </button>
      </form>
    </Modal>
  );
}

const UNDO_MS = 8_000;

/** "Added …" with Undo for 8 seconds. Undo deletes exactly what was just made. */
function UndoToast({ toast, setToast }: { toast: NonNullable<Toast>; setToast: (t: Toast) => void }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const t = setTimeout(() => setToast(null), 'undone' in toast ? 3_000 : UNDO_MS);
    return () => clearTimeout(t);
  }, [toast, setToast]);
  const undo = useMutation({
    mutationFn: async () => {
      if (!('created' in toast)) return;
      const c = toast.created;
      if (c.kind === 'event') await deleteEvent(c.event.id);
      else await deleteTask(c.task.id);
    },
    onSuccess: () => {
      setToast({ undone: 'title' in toast ? toast.title : '' });
      void queryClient.invalidateQueries();
    },
  });
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6" role="status" aria-live="polite" data-testid="undo-toast">
      <div className="hub-fade-up flex max-w-md items-center gap-3 rounded-card border border-line bg-ink px-4 py-3 text-[13px] text-card shadow-lift">
        {'undone' in toast ? (
          <span>Removed “{toast.undone}”.</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">
              Added “{toast.title}” {toast.created.kind === 'event' ? 'to your calendar' : 'to your tasks'}.
            </span>
            <button
              type="button"
              onClick={() => undo.mutate()}
              disabled={undo.isPending}
              className="inline-flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 font-semibold text-card underline-offset-2 hover:underline focus-visible:outline-card"
              data-testid="undo"
            >
              <Undo2 size={13} aria-hidden /> {undo.isPending ? 'Undoing…' : 'Undo'}
            </button>
          </>
        )}
        {undo.error && <span className="text-[12px] text-card">Couldn't undo: {undo.error.message}</span>}
      </div>
    </div>
  );
}

// The Tasks card: tasks without a date, each with a checkbox, an optional
// project chip, Delete and "Add date" (which turns it into a calendar event).
// Completed tasks fold into "Done today".
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ChevronRight, ListTodo, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { createTask, deleteTask, scheduleTask, updateTask, type ProjectDto, type TaskDto } from '../api.ts';
import { Card, IconButton, ProjectChip, SoftButton } from '../ui.tsx';
import { doneToday, openTasks } from './model.ts';

const input = 'h-8 min-w-0 rounded-btn border border-control bg-card px-2.5 text-[13px] text-ink placeholder:text-muted focus-visible:border-accent';

export function TasksCard({ tasks, projects, calendarReady }: { tasks: TaskDto[]; projects: ProjectDto[]; calendarReady: boolean }) {
  const names = new Map(projects.map((p) => [p.slug, p.name]));
  const open = openTasks(tasks);
  const done = doneToday(tasks);
  const [showDone, setShowDone] = useState(false);
  return (
    <Card as="section" className="flex min-w-0 flex-col p-5" data-testid="tasks" aria-labelledby="tasks-h">
      <div className="flex items-center gap-2">
        <ListTodo size={16} aria-hidden className="text-muted" />
        <h2 id="tasks-h" className="text-[15px] font-semibold text-ink">
          Tasks
        </h2>
        <span className="tnum text-[12px] text-muted">{open.length} open</span>
      </div>
      <AddTask projects={projects} />
      <ul className="mt-2 divide-y divide-line" data-testid="tasks-open">
        {open.length === 0 && <li className="py-3 text-[13px] text-muted">No open tasks.</li>}
        {open.map((t) => (
          <TaskRow key={t.id} t={t} project={t.project ? names.get(t.project) : undefined} calendarReady={calendarReady} />
        ))}
      </ul>
      {done.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <button type="button" className="flex items-center gap-1.5 rounded-btn px-1 py-1 text-[12px] font-medium text-muted hover:text-ink" aria-expanded={showDone} aria-controls="tasks-done" onClick={() => setShowDone(!showDone)}>
            <ChevronRight size={13} aria-hidden className={`transition-transform ${showDone ? 'rotate-90' : ''}`} />
            Done today ({done.length})
          </button>
          {showDone && (
            <ul id="tasks-done" className="divide-y divide-line" data-testid="tasks-done">
              {done.map((t) => (
                <TaskRow key={t.id} t={t} project={t.project ? names.get(t.project) : undefined} calendarReady={false} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function AddTask({ projects }: { projects: ProjectDto[] }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const add = useMutation({
    mutationFn: () => createTask(title.trim(), project || null),
    onSuccess: () => {
      setTitle('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) add.mutate();
  };
  return (
    <form className="mt-3 flex flex-wrap gap-2" onSubmit={submit} data-testid="add-task">
      <label htmlFor="new-task" className="sr-only">
        New task
      </label>
      <input id="new-task" className={`${input} flex-[1_1_140px]`} placeholder="Add a task" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
      <label htmlFor="new-task-project" className="sr-only">
        Project for the new task
      </label>
      <select id="new-task-project" className={`${input} w-32`} value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">No project</option>
        {projects.filter((p) => !p.archived).map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>
      <IconButton label="Add task" onClick={() => title.trim() && add.mutate()} disabled={!title.trim() || add.isPending}>
        <Plus size={15} aria-hidden />
      </IconButton>
      {add.error && (
        <p role="alert" className="w-full text-[12px] text-red-700 dark:text-red-300">
          {add.error.message}
        </p>
      )}
    </form>
  );
}

function TaskRow({ t, project, calendarReady }: { t: TaskDto; project?: string; calendarReady: boolean }) {
  const queryClient = useQueryClient();
  const [dating, setDating] = useState(false);
  const refresh = () => void queryClient.invalidateQueries();
  const toggle = useMutation({ mutationFn: (done: boolean) => updateTask(t.id, { done }), onSettled: refresh });
  const remove = useMutation({ mutationFn: () => deleteTask(t.id), onSettled: refresh });
  const done = !!t.completedAt;
  const id = `task-${t.id}`;
  return (
    <li className="py-2" data-testid="task">
      <div className="flex items-center gap-2.5">
        <input
          id={id}
          type="checkbox"
          className="size-4 shrink-0 accent-[var(--color-accent)]"
          checked={toggle.isPending ? toggle.variables : done}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <label htmlFor={id} className={`min-w-0 flex-1 text-[13px] ${done ? 'text-muted line-through' : 'text-ink'}`}>
          {t.title}
          {done && <span className="sr-only"> (done)</span>}
        </label>
        {t.project && project && (
          <span className="flex shrink-0 items-center" title={project}>
            <ProjectChip slug={t.project} name={project} size={20} />
            <span className="sr-only">{project}</span>
          </span>
        )}
        {!done && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-btn px-1.5 py-1 text-[12px] text-muted hover:bg-soft hover:text-ink disabled:opacity-40"
            onClick={() => setDating(!dating)}
            aria-expanded={dating}
            disabled={!calendarReady}
            title={calendarReady ? 'Turn it into a calendar event' : 'Connect Google Calendar first'}
          >
            <CalendarPlus size={13} aria-hidden /> Add date
          </button>
        )}
        <IconButton label={`Delete "${t.title}"`} onClick={() => remove.mutate()} disabled={remove.isPending} className="size-7">
          <Trash2 size={13} aria-hidden />
        </IconButton>
      </div>
      {dating && <DateForm t={t} onDone={() => setDating(false)} />}
    </li>
  );
}

function DateForm({ t, onDone }: { t: TaskDto; onDone: () => void }) {
  const queryClient = useQueryClient();
  const today = new Date();
  const [date, setDate] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
  const [time, setTime] = useState('');
  const save = useMutation({
    mutationFn: () => scheduleTask(t.id, time ? { start: `${date}T${time}`, allDay: false } : { start: date, allDay: true }),
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries();
    },
  });
  return (
    <form
      className="mt-2 ml-6 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (date) save.mutate();
      }}
      data-testid="task-date-form"
    >
      <label className="text-[12px] text-muted">
        <span className="sr-only">Date for "{t.title}"</span>
        <input type="date" required className={input} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="text-[12px] text-muted">
        <span className="sr-only">Time (leave empty for all day)</span>
        <input type="time" className={input} value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <SoftButton onClick={() => date && save.mutate()} disabled={!date || save.isPending}>
        {save.isPending ? 'Adding…' : time ? 'Add event' : 'Add all-day event'}
      </SoftButton>
      <button type="button" className="text-[12px] text-muted hover:text-ink hover:underline" onClick={onDone}>
        Cancel
      </button>
      {save.error && (
        <p role="alert" className="w-full text-[12px] text-red-700 dark:text-red-300">
          {save.error.message}
        </p>
      )}
    </form>
  );
}

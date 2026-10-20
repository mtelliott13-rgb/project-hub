// Add and Edit project, plus Delete with a confirmation step.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addProject, deleteProject, updateProject, type ProjectDto, type ProjectInput } from './api.ts';
import { FolderPicker } from './FolderPicker.tsx';
import { Action, Modal } from './ui.tsx';

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const inputClass = 'w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-950';

/** `project` absent means Add. */
export function ProjectForm({ project, onClose, onDeleted }: { project?: ProjectDto; onClose: () => void; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project?.name ?? '');
  const [repos, setRepos] = useState(project?.repos ?? []);
  const [folders, setFolders] = useState(project?.folders ?? []);
  const [github, setGithub] = useState(project?.github.join(', ') ?? '');
  const [claudeProject, setClaudeProject] = useState(project?.claudeProject ?? '');
  const [keywords, setKeywords] = useState(project?.keywords.join(', ') ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: async (input: ProjectInput) => {
      if (project) await updateProject(project.slug, input);
      else await addProject(input);
    },
    onSuccess: done,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: name.trim(),
      repos,
      folders,
      github: splitList(github),
      claude_project: claudeProject.trim() || null,
      keywords: splitList(keywords),
    });
  };

  if (project && confirmingDelete) {
    return (
      <ConfirmDelete
        project={project}
        onCancel={() => setConfirmingDelete(false)}
        onDeleted={() => {
          done();
          onDeleted?.();
        }}
      />
    );
  }

  return (
    <Modal title={project ? `Edit ${project.name}` : 'Add project'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Name</span>
          <input autoFocus required className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          {project && <span className="block text-xs text-stone-500">Slug stays {project.slug}</span>}
        </label>
        <FolderPicker label="Repos" kind="repos" value={repos} onChange={setRepos} />
        <FolderPicker label="Folders" kind="folders" value={folders} onChange={setFolders} />
        <label className="block space-y-1">
          <span className="text-sm font-medium">GitHub repo</span>
          <input className={inputClass} placeholder="owner/repo" value={github} onChange={(e) => setGithub(e.target.value)} />
          <span className="block text-xs text-stone-500">owner/repo; separate more than one with commas</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Claude Project link</span>
          <input className={inputClass} placeholder="https://claude.ai/project/…" value={claudeProject} onChange={(e) => setClaudeProject(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Keywords</span>
          <input className={inputClass} placeholder="acme, landing page" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          <span className="block text-xs text-stone-500">Separate with commas</span>
        </label>

        {save.error && <p className="text-sm text-red-600">{save.error.message}</p>}
        <div className="flex items-center gap-2 pt-2">
          {project && (
            <Action danger small onClick={() => setConfirmingDelete(true)}>
              Delete…
            </Action>
          )}
          <span className="flex-1" />
          <Action onClick={onClose}>Cancel</Action>
          <Action primary type="submit" disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Saving…' : project ? 'Save' : 'Add project'}
          </Action>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDelete({ project, onCancel, onDeleted }: { project: ProjectDto; onCancel: () => void; onDeleted: () => void }) {
  const remove = useMutation({ mutationFn: () => deleteProject(project.slug), onSuccess: onDeleted });
  const n = project.sessions.length;
  return (
    <Modal title={`Delete ${project.name}?`} onClose={onCancel}>
      <div className="space-y-3 text-sm">
        <p>This removes the hub's record of the project: its entry in projects.yaml and its card.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Nothing on disk is touched.</strong> Its repos and folders stay exactly as they are.
          </li>
          <li>
            {n === 0 ? 'It has no sessions.' : `Its ${n} session${n === 1 ? '' : 's'} stay in the hub, unfiled.`}
          </li>
        </ul>
        <p className="text-stone-500">To hide it but keep everything, use Archive instead.</p>
        {remove.error && <p className="text-red-600">{remove.error.message}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Action onClick={onCancel}>Cancel</Action>
          <Action danger disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? 'Deleting…' : 'Delete project'}
          </Action>
        </div>
      </div>
    </Modal>
  );
}

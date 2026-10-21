// Talking to the hub. Writes carry the token the hub injected into this page;
// see hubPageRefusal in src/server/app.ts.
import type { Project, Session } from '../../src/server/db/schema.ts';
import type { FolderEntry } from '../../src/server/folders.ts';
import type { ProjectInput } from '../../src/server/projects-file.ts';

// Dates arrive as ISO strings over JSON.
type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
/** `resumeProblem` says why a session can't be reopened; null means Resume works. */
export type SessionDto = Jsonified<Session> & { resumeProblem: string | null };
export type ProjectDto = Jsonified<Project> & { sessions: SessionDto[] };
export type { FolderEntry, ProjectInput };
export type Browse = { path: string; parent: string | null; isRepo: boolean; entries: FolderEntry[] };

const token = () => document.querySelector<HTMLMetaElement>('meta[name="hub-token"]')?.content ?? '';

/** Fetches JSON from the hub, with the token. Throws the hub's reason on failure. */
export async function hub<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'X-Hub-Token': token(),
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${init.method ?? 'GET'} ${url} failed (${res.status})`);
  return json as T;
}

export const fetchProjects = () => hub<ProjectDto[]>('/api/projects');
export const fetchFileError = () => hub<{ error: string | null }>('/api/projects-file');

type Ok<T> = { ok: true; result: T };
export const addProject = (input: ProjectInput) => hub<Ok<string>>('/api/projects', { method: 'POST', body: input });
export const updateProject = (slug: string, input: ProjectInput) =>
  hub<Ok<null>>(`/api/projects/${slug}`, { method: 'PUT', body: input });
export const archiveProject = (slug: string, archived: boolean) =>
  hub<Ok<null>>(`/api/projects/${slug}/${archived ? 'archive' : 'unarchive'}`, { method: 'POST', body: {} });
export const deleteProject = (slug: string) =>
  hub<Ok<{ unfiledSessions: number }>>(`/api/projects/${slug}`, { method: 'DELETE' });

export const folderSuggestions = () => hub<FolderEntry[]>('/api/folders/suggestions');
export const browseFolder = (path?: string) =>
  hub<Browse>(`/api/folders/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);

// Phase 4: notes, Monetize drafts, ideas.
export type Saved = { savedAt: string };
export type DraftMeta = { id: string; generatedAt: string; costUsd: number | null; editedAt: string | null };
export type Draft = DraftMeta & { text: string };
export type MonetizeJob = { state: 'running'; startedAt: string } | { state: 'failed'; error: string; at: string } | null;
export type Idea = { line: number; text: string; scope: string; done: boolean; added: string | null; doneOn: string | null };

export const fetchNotes = (slug: string) => hub<{ text: string; savedAt: string | null }>(`/api/projects/${slug}/notes`);
export const saveNotes = (slug: string, text: string) => hub<Saved>(`/api/projects/${slug}/notes`, { method: 'PUT', body: { text } });

export const fetchMonetize = (slug: string) =>
  hub<{ drafts: DraftMeta[]; job: MonetizeJob; command: string }>(`/api/projects/${slug}/monetize`);
export const fetchDraft = (slug: string, id: string) => hub<Draft>(`/api/projects/${slug}/monetize/${id}`);
export const saveDraft = (slug: string, id: string, text: string) =>
  hub<Saved>(`/api/projects/${slug}/monetize/${id}`, { method: 'PUT', body: { text } });
export const generateDraft = (slug: string) => hub<{ ok: true }>(`/api/projects/${slug}/monetize/generate`, { method: 'POST', body: {} });

type Ideas = { items: Idea[] };
export const fetchIdeas = () => hub<Ideas & { file: string }>('/api/ideas');
export const addIdea = (text: string, scope: string) => hub<Ideas>('/api/ideas', { method: 'POST', body: { text, scope } });
export const changeIdea = (idea: Idea, change: { text?: string; scope?: string; done?: boolean }) =>
  hub<Ideas>(`/api/ideas/${idea.line}`, { method: 'PUT', body: { expect: idea.text, ...change } });
export const deleteIdea = (idea: Idea) => hub<Ideas>(`/api/ideas/${idea.line}`, { method: 'DELETE', body: { expect: idea.text } });

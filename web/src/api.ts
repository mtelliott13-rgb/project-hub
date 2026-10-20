// Talking to the hub. Writes carry the token the hub injected into this page;
// see hubPageRefusal in src/server/app.ts.
import type { Project, Session } from '../../src/server/db/schema.ts';
import type { FolderEntry } from '../../src/server/folders.ts';
import type { ProjectInput } from '../../src/server/projects-file.ts';

// Dates arrive as ISO strings over JSON.
type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type SessionDto = Jsonified<Session>;
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

// Talking to the hub. Writes carry the token the hub injected into this page;
// see hubPageRefusal in src/server/app.ts.
import type { Chat, Link, LinkRule, Project, Session } from '../../src/server/db/schema.ts';
import type { FolderEntry } from '../../src/server/folders.ts';
import type { ProjectInput } from '../../src/server/projects-file.ts';
import type { ActivityEvent, ProjectActivity } from '../../src/server/activity.ts';
import type { Application, FieldCount, FillPart, FillSheet, Queue } from '../../src/server/applications.ts';
import type { AppStatus } from '../../src/server/queue-rules.ts';
import type { RepoStatus } from '../../src/server/repos.ts';
import type { Toolkit, ToolkitStatus } from '../../src/server/toolkit.ts';

// Dates arrive as ISO strings over JSON.
type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
/** `resumeProblem` says why a session can't be reopened; null means Resume works. */
export type SessionDto = Jsonified<Session> & { resumeProblem: string | null };
/** `repoStatus` lines up with `repos`; an entry is null until its first check. `toolkit` is null without a toolkit.yaml. */
export type ProjectDto = Jsonified<Project> & {
  sessions: SessionDto[];
  /** Its claude.ai chats, newest first. */
  chats: Jsonified<Chat>[];
  repoStatus: (RepoStatus | null)[];
  toolkit: { file: string; done: number; total: number; error: string | null } | null;
  /** Null without a review queue (jobs/queue.yaml or jobs/queue/review_queue.yaml). */
  applications: { summary: string | null; total: number; error: string | null } | null;
};
export type { RepoStatus };
export type { FolderEntry, ProjectInput };
export type Browse = { path: string; parent: string | null; isRepo: boolean; entries: FolderEntry[] };

const token = () => document.querySelector<HTMLMetaElement>('meta[name="hub-token"]')?.content ?? '';

/** A failed hub call: the hub's reason, its status, and the rest of its answer. */
export class HubError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Fetches JSON from the hub, with the token. Throws a HubError with the hub's reason on failure. */
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
  if (!res.ok) throw new HubError(json.error ?? `${init.method ?? 'GET'} ${url} failed (${res.status})`, res.status, json);
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

// Collectors (projects.yaml `collector:`), e.g. Meme Radar's app.
export type SourceHealth = { id: string; label: string; status: string; lastSuccess: string | null; lastError: string | null };
export type CollectorStatus = (
  | { state: 'running'; pid: number; command: string; startedAt: string | null }
  | { state: 'stopped' | 'starting' }
  | { state: 'port-busy'; pid: number; command: string }
) & { port: number; sources: SourceHealth[] | null; error: string | null };
export const fetchCollector = (slug: string) => hub<CollectorStatus>(`/api/projects/${slug}/collector`);

// Phase 5: check a project's repos now.
export const refreshRepos = (slug: string) =>
  hub<{ ok: true; repoStatus: (RepoStatus | null)[] }>(`/api/projects/${slug}/repos/refresh`, { method: 'POST', body: {} });

// Toolkit: toolkit.yaml in a project folder. `error` is set when the file can't be read.
export type { Toolkit, ToolkitStatus };
export type ToolkitResponse = (Toolkit & { others: string[]; error?: undefined }) | { file: string; error: string };
export const toolkitOk = (r: ToolkitResponse | undefined): r is Toolkit & { others: string[] } => !!r && 'items' in r;
export const fetchToolkit = (slug: string) => hub<ToolkitResponse>(`/api/projects/${slug}/toolkit`);
export const setToolkitStatus = (slug: string, item: { index: number; name: string }, status: ToolkitStatus, version: string) =>
  hub<Toolkit>(`/api/projects/${slug}/toolkit/items/${item.index}`, { method: 'PUT', body: { name: item.name, status, version } });

// Phase 6: recent files, links, link rules and the Inbox.
export type { Link, LinkRule };
export type RecentFile = { path: string; root: string; rel: string; mtime: string };
export type FilesResponse = { files: RecentFile[]; watching: { dir: string; ready: boolean; error: string | null }[]; missing: string[] };
export type RuleChoice = { host: string; pathPrefix: string; label: string };
/** A link with the rules "always file these here" can offer for it. */
export type LinkDto = Jsonified<Link> & { choices: RuleChoice[]; suggested: number };
export type InboxSession = SessionDto & { folder: string; folderProblem: string | null };
export type Inbox = { links: LinkDto[]; sessions: InboxSession[]; chats: Jsonified<Chat>[] };

export const fetchFiles = (slug: string) => hub<FilesResponse>(`/api/projects/${slug}/files`);
export const fetchProjectLinks = (slug: string) => hub<Jsonified<Link>[]>(`/api/projects/${slug}/links`);
export const fetchInbox = () => hub<Inbox>('/api/inbox');
export const addLink = (input: { url: string; title?: string; slug?: string }) =>
  hub<{ link: LinkDto; existed: boolean }>('/api/links', { method: 'POST', body: input });
/** Files a link into a project, or back into the Inbox with null. */
export const fileLink = (id: number, slug: string | null) => hub<{ link: LinkDto }>(`/api/links/${id}`, { method: 'PUT', body: { slug } });
export const deleteLink = (id: number) => hub<{ ok: true }>(`/api/links/${id}`, { method: 'DELETE' });
export const fetchRules = () => hub<Jsonified<LinkRule>[]>('/api/link-rules');
export const addRule = (slug: string, choice: RuleChoice) =>
  hub<{ rule: Jsonified<LinkRule>; filed: number }>('/api/link-rules', { method: 'POST', body: { slug, host: choice.host, pathPrefix: choice.pathPrefix } });
export const deleteRule = (id: number) => hub<{ ok: true }>(`/api/link-rules/${id}`, { method: 'DELETE' });
export const fileSession = (id: string, slug: string, always: boolean) =>
  hub<{ ok: true }>(`/api/inbox/sessions/${id}/file`, { method: 'POST', body: { slug, always } });

// Phase 7: claude.ai chats, Claude Project mappings, the data-export import.
export type ChatDto = Jsonified<Chat>;
export type ClaudeProjectRow = { id: string; name: string | null; projectSlug: string | null; yamlSlug: string | null; chats: number };
export type ClaudeProjects = { claudeProjects: ClaudeProjectRow[]; extension: { id: string; lastHeard: { at: string; chatId: string } | null } };
export type ImportResult = { chats: number; added: number; claudeProjects: number; skipped: number; filed: number; inbox: number };

/** Files a chat by hand, or (null) back to automatic filing. */
export const fileChat = (id: string, slug: string | null) => hub<{ chat: ChatDto }>(`/api/chats/${id}`, { method: 'PUT', body: { slug } });
export const fetchClaudeProjects = () => hub<ClaudeProjects>('/api/claude-projects');
export const mapClaudeProject = (id: string, slug: string | null) =>
  hub<{ ok: true; moved: number }>(`/api/claude-projects/${id}`, { method: 'PUT', body: { slug } });

/** Uploads the export (.zip as downloaded, or conversations.json). */
export async function importExport(file: File): Promise<ImportResult> {
  const res = await fetch('/api/import/claude-export', {
    method: 'POST',
    headers: { 'X-Hub-Token': token(), 'Content-Type': /\.zip$/i.test(file.name) ? 'application/zip' : 'application/json' },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HubError(json.error ?? `Import failed (${res.status})`, res.status, json);
  return json as ImportResult;
}

// Phase 8: newest activity per project (home page), and one project's timeline.
export type { ActivityEvent, ProjectActivity };
export const fetchActivity = () => hub<Record<string, ProjectActivity>>('/api/activity');
export const fetchTimeline = (slug: string, limit: number) =>
  hub<{ events: ActivityEvent[]; total: number }>(`/api/projects/${slug}/activity?limit=${limit}`);

// Applications: Career HQ's review queue and fill sheets (read only; status
// changes run Career HQ's own command through /api/launch).
export type { Application, FieldCount, FillPart, FillSheet };
/** The queue plus any other queue files found but not shown (the newer one wins). */
export type ShownQueue = Queue & { others: string[] };
export type QueueResponse = ShownQueue | { file: string; error: string };
export const queueOk = (r: QueueResponse | undefined): r is ShownQueue => !!r && 'items' in r;
export const fetchQueue = (slug: string) => hub<QueueResponse>(`/api/projects/${slug}/applications`);
export const fetchFillSheet = (slug: string, id: string) => hub<FillSheet>(`/api/projects/${slug}/applications/${encodeURIComponent(id)}/fill-sheet`);
/**
 * Runs Career HQ's status command for one application. On failure the
 * HubError's body has `output` (the command's last lines) and `command` (to copy),
 * or `current` (the queue) when the page was stale.
 */
export const setApplicationStatus = (slug: string, id: string, status: AppStatus, version: string) =>
  hub<{ command: string; queue: ShownQueue }>('/api/launch', { method: 'POST', body: { kind: 'queue-status', slug, id, status, version } });

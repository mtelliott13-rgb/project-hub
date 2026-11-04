// The hub's MCP server (Phase 9): five read-only tools over the hub's /agent
// routes (src/server/agent-routes.ts). scripts/mcp.ts runs it over stdio for
// Claude Code and the Claude desktop app; tests connect to it in memory.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** GETs one /agent/v1 path from the hub and returns its JSON, or throws with the hub's reason. */
export type AgentFetch = (path: string) => Promise<unknown>;

export const HUB_DOWN = "The Project Hub isn't running (nothing answered on http://127.0.0.1:4747). Start it with `pnpm start` in ~/project-hub, or `pnpm agent:install` to run it at login.";

/** Calls the running hub with the agent token. */
export function hubFetch(base: string, token: string, fetcher: typeof fetch = fetch): AgentFetch {
  return async (path) => {
    let res: Response;
    try {
      res = await fetcher(`${base}/agent/v1${path}`, { headers: { 'X-Agent-Token': token } });
    } catch {
      throw new Error(HUB_DOWN);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `The hub answered ${res.status}`);
    return body;
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const slug = z.string().regex(/^[a-z0-9-]+$/).describe('The project slug, e.g. "meme-radar" (list_projects gives them)');

/** The tools, in order. test/phase9.test.ts pins this list. */
export function createMcpServer(get: AgentFetch, version = '1.0.0') {
  const server = new McpServer(
    { name: 'project-hub', version },
    {
      instructions:
        "Read-only view of the user's Project Hub (their local dashboard of projects on this Mac): status badges, last activity, recent Claude Code sessions, open ideas and toolkit checklists. Start with list_projects to get slugs. Times are ISO with a precomputed `ago`. Nothing here can change anything.",
    },
  );
  const answer = async (path: string) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await get(path), null, 1) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
    }
  };
  const query = (params: Record<string, string | number | boolean | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== false) q.set(k, v === true ? '1' : String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        "Every project in the hub with its status badges (running, CI failing, PRs waiting, uncommitted, to push, stale), last activity, toolkit progress and open-idea count. Sorted as on the hub's home page: running first, then newest activity, archived last.",
      inputSchema: { include_archived: z.boolean().optional().describe('Also list archived projects (default false)') },
      annotations: { title: 'List projects', ...READ_ONLY },
    },
    ({ include_archived }) => answer(`/projects${query({ archived: include_archived })}`),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description:
        "One project in detail: status badges, last activity, each repo's branch, uncommitted files, ahead/behind, CI result and open PRs, its 10 most recent sessions, toolkit summary, open ideas and the last 20 timeline events (sessions, chats, commits, CI, saved files, links).",
      inputSchema: { slug },
      annotations: { title: 'Get project', ...READ_ONLY },
    },
    ({ slug }) => answer(`/projects/${slug}`),
  );

  server.registerTool(
    'recent_sessions',
    {
      title: 'Recent sessions',
      description:
        'Recent Claude Code sessions filed to projects, newest first: title, project, running or ended, when, branch, folder, and the `claude --resume` command when it can be reopened.',
      inputSchema: {
        slug: slug.optional().describe('Only this project (default: all projects)'),
        limit: z.number().int().min(1).max(50).optional().describe('How many (default 10, at most 50)'),
      },
      annotations: { title: 'Recent sessions', ...READ_ONLY },
    },
    ({ slug, limit }) => answer(`/sessions${query({ slug, limit })}`),
  );

  server.registerTool(
    'list_ideas',
    {
      title: 'List ideas',
      description:
        "Ideas from the hub's Ideas page (~/.project-hub/ideas.md): features wanted for the hub (scope \"hub\") or a project (scope = its slug). Open ones only unless include_done.",
      inputSchema: {
        scope: z.string().regex(/^[a-z0-9-]+$/).optional().describe('Only this scope: "hub" or a project slug'),
        include_done: z.boolean().optional().describe('Also list ideas already done (default false)'),
      },
      annotations: { title: 'List ideas', ...READ_ONLY },
    },
    ({ scope, include_done }) => answer(`/ideas${query({ scope, done: include_done })}`),
  );

  server.registerTool(
    'get_toolkit',
    {
      title: 'Get toolkit',
      description:
        "A project's toolkit.yaml checklist: X of Y done (parked items don't count) and every item's name, category, status, cost, why, notes, target date, whether it's overdue, and link.",
      inputSchema: { slug },
      annotations: { title: 'Get toolkit', ...READ_ONLY },
    },
    ({ slug }) => answer(`/projects/${slug}/toolkit`),
  );

  return server;
}

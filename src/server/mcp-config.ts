// Registering the hub's MCP server (Phase 9): the Claude desktop app's
// claude_desktop_config.json entry, and the Claude Code allow rules for the
// read-only tools (never add_reminder). Pure functions; scripts/install-mcp.ts does the I/O.
import path from 'node:path';

export const MCP_NAME = 'project-hub';
export const MCP_TOOLS = ['list_projects', 'get_project', 'recent_sessions', 'list_ideas', 'get_toolkit', 'list_agenda', 'add_reminder'] as const;
/** Tools pre-approved in ~/.claude/settings.json: the read-only ones. add_reminder is left out on purpose, so Claude Code asks you before every call. */
export const READ_ONLY_TOOLS = MCP_TOOLS.filter((t) => t !== 'add_reminder');
/** Claude Code permission rules, one per tool, so a tool added later is never pre-approved. */
export const ALLOW_RULES = READ_ONLY_TOOLS.map((t) => `mcp__${MCP_NAME}__${t}`);

/** How to start the server: full paths, since the desktop app doesn't read ~/.zshrc. */
export function mcpCommand(home: string) {
  return {
    command: path.join(home, '.local/node/bin/node'),
    args: ['--disable-warning=ExperimentalWarning', path.join(home, 'project-hub/scripts/mcp.ts')],
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Adds (or updates) only `mcpServers["project-hub"]`; every other key stays as it was. */
export function withDesktopEntry(config: Json, home: string): Json {
  return { ...config, mcpServers: { ...obj(config.mcpServers), [MCP_NAME]: mcpCommand(home) } };
}

/** Removes only the hub's entry, and `mcpServers` itself if that leaves it empty. */
export function withoutDesktopEntry(config: Json): Json {
  if (!('mcpServers' in config)) return config;
  const { [MCP_NAME]: _gone, ...rest } = obj(config.mcpServers);
  const { mcpServers: _old, ...others } = config;
  return Object.keys(rest).length ? { ...others, mcpServers: rest } : others;
}

/** Adds the allow rules to `permissions.allow`, keeping everything else and never duplicating. */
export function withAllowRules(settings: Json): Json {
  const permissions = obj(settings.permissions);
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  return { ...settings, permissions: { ...permissions, allow: [...allow, ...ALLOW_RULES.filter((r) => !allow.includes(r))] } };
}

/** Removes only the hub's allow rules. */
export function withoutAllowRules(settings: Json): Json {
  const permissions = obj(settings.permissions);
  if (!Array.isArray(permissions.allow)) return settings;
  return { ...settings, permissions: { ...permissions, allow: (permissions.allow as unknown[]).filter((r) => !ALLOW_RULES.includes(r as never)) } };
}

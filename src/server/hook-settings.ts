// Merging the hub's hooks into ~/.claude/settings.json (SPEC.md, "Hook setup").
// Everything else in the file is kept as it is.

export const HUB_HOOK_COMMAND = '$HOME/.project-hub/hub-hook.sh';
export const HUB_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'] as const;

export const HUB_HOOK_SCRIPT = `#!/bin/sh
# ~/.project-hub/hub-hook.sh
# Forwards the hook's JSON to the hub. Prints nothing and never fails,
# so Claude Code is never slowed or blocked when the hub is down.
TOKEN=$(cat "$HOME/.project-hub/token" 2>/dev/null)
curl -s -o /dev/null -m 1 -X POST -H 'Content-Type: application/json' -H "X-Hub-Token: $TOKEN" --data-binary @- http://127.0.0.1:4747/hooks/claude || true
exit 0
`;

type Hook = { type: string; command?: string; async?: boolean; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks: Hook[]; [k: string]: unknown };
export type Settings = { cleanupPeriodDays?: number; hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

const isHubGroup = (g: HookGroup) => g.hooks?.some((h) => h.command === HUB_HOOK_COMMAND);

/** Adds the hub's hooks (once) and raises cleanupPeriodDays to at least `cleanupDays`. */
export function mergeHubHooks(settings: Settings, cleanupDays: number): Settings {
  const out: Settings = structuredClone(settings);
  if (!(typeof out.cleanupPeriodDays === 'number' && out.cleanupPeriodDays >= cleanupDays)) {
    out.cleanupPeriodDays = cleanupDays;
  }
  out.hooks ??= {};
  for (const event of HUB_EVENTS) {
    const groups = (out.hooks[event] ??= []);
    if (groups.some(isHubGroup)) continue;
    const hook: Hook = { type: 'command', command: HUB_HOOK_COMMAND };
    if (event === 'Stop') hook.async = true;
    groups.push({ hooks: [hook] });
  }
  return out;
}

/** Removes only the hub's hook groups; cleanupPeriodDays is left as is. */
export function removeHubHooks(settings: Settings): Settings {
  const out: Settings = structuredClone(settings);
  if (!out.hooks) return out;
  for (const event of HUB_EVENTS) {
    const kept = out.hooks[event]?.filter((g) => !isHubGroup(g));
    if (kept === undefined) continue;
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export const formatSettings = (settings: Settings) => JSON.stringify(settings, null, 2) + '\n';

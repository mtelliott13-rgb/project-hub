// Calls POST /api/launch with the token the hub injected into this page.
// See src/server/launcher.ts for what each kind runs.

export type LaunchBody =
  | { kind: 'session' | 'desktop'; sessionId: string }
  | { kind: 'new-session' | 'editor' | 'claude-project'; slug: string; path?: string }
  | { kind: 'chat'; chatId: string }
  | { kind: 'from-pr'; slug: string; pr: number; path?: string };

const token = () => document.querySelector<HTMLMetaElement>('meta[name="hub-token"]')?.content ?? '';

/** Runs a launch and returns the exact command the hub ran. Throws with the hub's reason on failure. */
export async function launch(body: LaunchBody): Promise<string> {
  const res = await fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Launch failed (${res.status})`);
  return json.command;
}

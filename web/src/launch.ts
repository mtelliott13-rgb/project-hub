// Calls POST /api/launch. See src/server/launcher.ts for what each kind runs.
import { hub } from './api.ts';

export type LaunchBody =
  | { kind: 'session' | 'desktop'; sessionId: string }
  | { kind: 'new-session' | 'editor' | 'claude-project'; slug: string; path?: string }
  | { kind: 'chat'; chatId: string; in?: 'desktop' | 'browser' }
  | { kind: 'from-pr'; slug: string; pr: number; path?: string }
  | { kind: 'file'; slug: string; path: string }
  | { kind: 'packet-file'; slug: string; id: string; file: 'resume' | 'cover-letter' }
  | { kind: 'collector-start' | 'collector-stop'; slug: string };

/** Runs a launch and returns the exact command the hub ran. Throws with the hub's reason on failure. */
export const launch = async (body: LaunchBody) => (await hub<{ command: string }>('/api/launch', { method: 'POST', body })).command;

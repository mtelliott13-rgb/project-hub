// Which sessions the page offers to reopen. Sessions arrive newest first, each
// with `resumeProblem` (null when `claude --resume` can reopen it).
type S = { resumeProblem: string | null; state: string };

/** What Resume reopens: the newest session that can be reopened. */
export const latestReopenable = <T extends S>(sessions: T[]): T | undefined => sessions.find((s) => s.resumeProblem === null);

/** Sessions listed with buttons: reopenable ones, plus any running now. */
export const listed = <T extends S>(sessions: T[]): T[] => sessions.filter((s) => s.resumeProblem === null || s.state === 'running');

type Timed = { lastActiveAt: string };

/**
 * What Resume opens: whichever was touched last, the newest reopenable session
 * or the newest chat (chats arrive newest first). A chat's time is when you
 * last had it open in Chrome, or its last update in the data export.
 */
export function resumeTarget<Se extends S & Timed, C extends Timed>(sessions: Se[], chats: C[]): { kind: 'session'; session: Se } | { kind: 'chat'; chat: C } | null {
  const session = latestReopenable(sessions);
  const chat = chats[0];
  if (chat && (!session || chat.lastActiveAt > session.lastActiveAt)) return { kind: 'chat', chat };
  return session ? { kind: 'session', session } : null;
}

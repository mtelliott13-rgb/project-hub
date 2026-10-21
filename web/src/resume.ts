// Which sessions the page offers to reopen. Sessions arrive newest first, each
// with `resumeProblem` (null when `claude --resume` can reopen it).
type S = { resumeProblem: string | null; state: string };

/** What Resume reopens: the newest session that can be reopened. */
export const latestReopenable = <T extends S>(sessions: T[]): T | undefined => sessions.find((s) => s.resumeProblem === null);

/** Sessions listed with buttons: reopenable ones, plus any running now. */
export const listed = <T extends S>(sessions: T[]): T[] => sessions.filter((s) => s.resumeProblem === null || s.state === 'running');

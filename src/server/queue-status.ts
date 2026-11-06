// Changing an application's status by running Career HQ's own command,
// `uv run python scripts/review_queue.py status <id> <status>`, in the repo
// that holds the queue. Career HQ owns the queue (it rebuilds it from each
// packet's meta.yaml), so the hub never edits the file. It goes through
// POST /api/launch, so it gets every Phase 2 check (hub page, Origin, page
// token, Host, JSON, dryRun). The request names only the project, the id, the
// status and the queue version the page loaded; the server checks each one and
// builds the whole command itself, which runs with no shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { findQueueFiles, QueueError, queueRoot, readQueue, withLimits, type Queue } from './applications.ts';
import type { Project } from './db/schema.ts';
import { shellQuote } from './launcher.ts';
import { APP_STATUSES } from './queue-rules.ts';

export const QUEUE_SCRIPT = 'scripts/review_queue.py';
/** Career HQ's ids: YYYY-MM-DD then lowercase words joined by single dashes. Nothing else reaches the command. */
export const APP_ID = /^\d{4}-\d{2}-\d{2}(-[a-z0-9]+)+$/;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;
const OUTPUT_LINES = 20;

export const queueStatusSchema = z.object({
  kind: z.literal('queue-status'),
  slug: z.string().min(1),
  id: z.string().max(200).regex(APP_ID, 'must look like YYYY-MM-DD-company-title'),
  status: z.enum(APP_STATUSES),
  version: z.string().regex(/^[0-9a-f]{64}$/, 'must be the queue version the page loaded'),
  dryRun: z.boolean().optional(),
});
export type QueueStatusRequest = z.infer<typeof queueStatusSchema>;

export type QueueStatusDeps = {
  project: (slug: string) => Project | undefined;
  /** Full path to uv (~/.local/bin/uv on this Mac). */
  uvPath: string;
  /** Your home folder, to write the copyable command with `~`. */
  home: string;
  /** Projects with a status command running now (one at a time each). */
  running: Set<string>;
  timeoutMs?: number;
};

export type QueueStatusResult = { status: 200 | 400 | 404 | 409 | 500; body: Record<string, unknown> };

/** Inside `root` once symlinks are followed, and a regular file. */
function realFileInside(root: string, rel: string): string | null {
  try {
    const real = fs.realpathSync(path.join(root, rel));
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

const tilde = (p: string, home: string) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);

/** The command as you'd type it in Terminal (also the copyable fallback). */
export function copyCommand(cwd: string, id: string, status: string, home: string) {
  const under = cwd.startsWith(home + path.sep) ? cwd.slice(home.length + 1) : null;
  const dir = under === null ? shellQuote(cwd) : `~/${shellQuote(under)}`;
  return `cd ${dir} && uv run python ${QUEUE_SCRIPT} status ${id} ${status}`;
}

const lastLines = (text: string) => text.trimEnd().split('\n').slice(-OUTPUT_LINES).join('\n');

type Run = { ok: true; output: string } | { ok: false; error: string; output: string };

function runCommand(argv: string[], cwd: string, timeoutMs: number): Promise<Run> {
  const env = {
    PATH: [path.dirname(argv[0]), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: process.env.HOME ?? '',
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
  };
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
      const output = lastLines([stderr, stdout].map((s) => s.trimEnd()).filter(Boolean).join('\n'));
      if (!err) return resolve({ ok: true, output });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string };
      const error =
        e.code === 'ENOENT'
          ? `Couldn't run ${argv[0]}`
          : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'The command printed more than 64 KB, so it was stopped'
            : e.killed
              ? `The command didn't finish within ${timeoutMs / 1000} seconds, so it was stopped`
              : typeof e.code === 'number'
                ? `Career HQ's status command failed (exit ${e.code})`
                : `Career HQ's status command failed: ${e.message}`;
      resolve({ ok: false, error, output });
    });
  });
}

/** Checks everything, then (unless dryRun) runs the command and confirms the queue shows the change. */
export async function changeQueueStatus(req: QueueStatusRequest, deps: QueueStatusDeps): Promise<QueueStatusResult> {
  const p = deps.project(req.slug);
  if (!p) return { status: 404, body: { error: `Unknown project ${req.slug}` } };
  const [file] = findQueueFiles(p);
  if (!file) return { status: 404, body: { error: 'This project has no review queue' } };
  let queue: Queue;
  try {
    queue = readQueue(file);
  } catch (e) {
    if (e instanceof QueueError) return { status: 409, body: { error: e.message } };
    throw e;
  }
  if (queue.version !== req.version) {
    return { status: 409, body: { error: 'The review queue changed since this page loaded it, so nothing was run. This is the current version.', current: queue } };
  }
  const item = queue.items.find((i) => i.id === req.id);
  if (!item) return { status: 404, body: { error: `"${req.id}" isn't in the review queue` } };

  let root: string;
  try {
    root = fs.realpathSync(queueRoot(file));
  } catch {
    return { status: 409, body: { error: `The folder holding ${path.basename(file)} is gone` } };
  }
  const command = copyCommand(root, req.id, req.status, deps.home);
  if (!realFileInside(root, QUEUE_SCRIPT)) {
    return { status: 409, body: { error: `No ${QUEUE_SCRIPT} inside ${tilde(root, deps.home)}`, command } };
  }
  const argv = [deps.uvPath, 'run', 'python', QUEUE_SCRIPT, 'status', req.id, req.status];
  if (req.dryRun) return { status: 200, body: { ok: true, dryRun: true, command, cwd: root, argv } };
  try {
    if (!fs.statSync(deps.uvPath).isFile()) throw new Error();
    fs.accessSync(deps.uvPath, fs.constants.X_OK);
  } catch {
    return { status: 409, body: { error: `uv isn't at ${tilde(deps.uvPath, deps.home)}, so the hub can't run Career HQ's command`, command } };
  }
  if (deps.running.has(p.slug)) return { status: 409, body: { error: 'A status change is already running for this project; try again in a moment', command } };

  deps.running.add(p.slug);
  try {
    console.log(`${new Date().toISOString()} Applications: ${p.slug}: cd ${root} && ${argv.map(shellQuote).join(' ')}`);
    const run = await runCommand(argv, root, deps.timeoutMs ?? TIMEOUT_MS);
    if (!run.ok) return { status: 500, body: { error: run.error, output: run.output, command } };
    // The script may have written the queue at either path; read whichever is newest now.
    const [after] = findQueueFiles(p);
    let now: Queue | null = null;
    try {
      now = after ? readQueue(after) : null;
    } catch {
      now = null;
    }
    const shown = now?.items.find((i) => i.id === req.id)?.status;
    if (shown !== req.status) {
      return {
        status: 500,
        body: { error: `The command finished, but the queue ${shown ? `still shows "${shown}"` : "couldn't be read afterwards"}`, output: run.output, command },
      };
    }
    return { status: 200, body: { ok: true, command, output: run.output, queue: { ...withLimits(now!), others: findQueueFiles(p).slice(1) } } };
  } finally {
    deps.running.delete(p.slug);
  }
}

// Running Career HQ's own commands in the repo that holds the queue:
//   uv run python scripts/review_queue.py status <id> <status>
//   uv run python scripts/review_queue.py approve-draft <id> <question-number> <draft-sha256>
// Career HQ owns the queue, meta.yaml, answers.yaml and the fill sheets, so the
// hub never edits them. Both go through POST /api/launch, so they get every
// Phase 2 check (hub page, Origin, page token, Host, JSON, dryRun). A request
// names only the project, the id and the command's values; the server checks
// each one and builds the whole command itself, which runs with no shell. One
// command per project at a time (both rewrite the same files).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fillSheetFor, findQueueFiles, QueueError, queueRoot, readQueue, withLimits, type Application, type Queue } from './applications.ts';
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

export const approveDraftSchema = z.object({
  kind: z.literal('approve-draft'),
  slug: z.string().min(1),
  id: z.string().max(200).regex(APP_ID, 'must look like YYYY-MM-DD-company-title'),
  // A JSON number, written out as plain digits: never 0, a leading zero or anything but ASCII digits.
  question: z.number().int().min(1).max(9999),
  // Of the draft exactly as the page showed it (the page computes it, never the server).
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be the lowercase hex SHA-256 of the draft as shown'),
  dryRun: z.boolean().optional(),
});
export type ApproveDraftRequest = z.infer<typeof approveDraftSchema>;

export type QueueStatusDeps = {
  project: (slug: string) => Project | undefined;
  /** Full path to uv (~/.local/bin/uv on this Mac). */
  uvPath: string;
  /** Your home folder, to write the copyable command with `~`. */
  home: string;
  /** Projects with a Career HQ command running now (one at a time each). */
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
export function copyCommand(cwd: string, args: string[], home: string) {
  const under = cwd.startsWith(home + path.sep) ? cwd.slice(home.length + 1) : null;
  const dir = under === null ? shellQuote(cwd) : `~/${shellQuote(under)}`;
  return `cd ${dir} && uv run python ${QUEUE_SCRIPT} ${args.map(shellQuote).join(' ')}`;
}

const lastLines = (text: string) => text.trimEnd().split('\n').slice(-OUTPUT_LINES).join('\n');

type Run = { ok: true; output: string; stdout: string } | { ok: false; error: string; output: string };

function runCommand(argv: string[], cwd: string, timeoutMs: number, what: string): Promise<Run> {
  const env = {
    PATH: [path.dirname(argv[0]), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: process.env.HOME ?? '',
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
  };
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
      const output = lastLines([stderr, stdout].map((s) => s.trimEnd()).filter(Boolean).join('\n'));
      if (!err) return resolve({ ok: true, output, stdout });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string };
      // Career HQ's commands print one "error: ..." line on failure; show that when there is one.
      const said = stderr.split('\n').find((l) => l.startsWith('error:'))?.trim();
      const error =
        said && typeof e.code === 'number'
          ? `${said} (exit ${e.code})`
          :
        e.code === 'ENOENT'
          ? `Couldn't run ${argv[0]}`
          : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'The command printed more than 64 KB, so it was stopped'
            : e.killed
              ? `The command didn't finish within ${timeoutMs / 1000} seconds, so it was stopped`
              : typeof e.code === 'number'
                ? `Career HQ's ${what} command failed (exit ${e.code})`
                : `Career HQ's ${what} command failed: ${e.message}`;
      resolve({ ok: false, error, output });
    });
  });
}

type Found = { p: Project; queue: Queue; item: Application; root: string };

/** The project, its queue, the item the id names and the repo; or why not. */
function find(slug: string, id: string, deps: QueueStatusDeps): Found | QueueStatusResult {
  const p = deps.project(slug);
  if (!p) return { status: 404, body: { error: `Unknown project ${slug}` } };
  const [file] = findQueueFiles(p);
  if (!file) return { status: 404, body: { error: 'This project has no review queue' } };
  let queue: Queue;
  try {
    queue = readQueue(file);
  } catch (e) {
    if (e instanceof QueueError) return { status: 409, body: { error: e.message } };
    throw e;
  }
  const item = queue.items.find((i) => i.id === id);
  if (!item) return { status: 404, body: { error: `"${id}" isn't in the review queue` } };
  try {
    return { p, queue, item, root: fs.realpathSync(queueRoot(file)) };
  } catch {
    return { status: 409, body: { error: `The folder holding ${path.basename(file)} is gone` } };
  }
}

/**
 * Checks the script and uv, then (unless dryRun) runs `review_queue.py <args>`
 * in the repo, one per project at a time. `check` confirms the command did
 * what it said, once it exits 0.
 */
async function runInRepo(
  f: Found,
  args: string[],
  what: string,
  dryRun: boolean | undefined,
  deps: QueueStatusDeps,
  check: (run: { output: string; stdout: string }, command: string) => QueueStatusResult,
): Promise<QueueStatusResult> {
  const { p, root } = f;
  const command = copyCommand(root, args, deps.home);
  if (!realFileInside(root, QUEUE_SCRIPT)) {
    return { status: 409, body: { error: `No ${QUEUE_SCRIPT} inside ${tilde(root, deps.home)}`, command } };
  }
  const argv = [deps.uvPath, 'run', 'python', QUEUE_SCRIPT, ...args];
  if (dryRun) return { status: 200, body: { ok: true, dryRun: true, command, cwd: root, argv } };
  try {
    if (!fs.statSync(deps.uvPath).isFile()) throw new Error();
    fs.accessSync(deps.uvPath, fs.constants.X_OK);
  } catch {
    return { status: 409, body: { error: `uv isn't at ${tilde(deps.uvPath, deps.home)}, so the hub can't run Career HQ's command`, command } };
  }
  if (deps.running.has(p.slug)) return { status: 409, body: { error: 'A status change or approval is already running for this project; try again in a moment', command } };

  deps.running.add(p.slug);
  try {
    console.log(`${new Date().toISOString()} Applications: ${p.slug}: cd ${root} && ${argv.map(shellQuote).join(' ')}`);
    const run = await runCommand(argv, root, deps.timeoutMs ?? TIMEOUT_MS, what);
    if (!run.ok) return { status: 500, body: { error: run.error, output: run.output, command } };
    return check(run, command);
  } finally {
    deps.running.delete(p.slug);
  }
}

/** The queue as it is now (whichever path is newest), with limits, for the page. */
function queueNow(p: Project) {
  const [file, ...others] = findQueueFiles(p);
  try {
    return file ? { ...withLimits(readQueue(file)), others } : null;
  } catch {
    return null;
  }
}

/** Changes a status if the queue is still the version the page loaded, and confirms the queue shows it. */
export async function changeQueueStatus(req: QueueStatusRequest, deps: QueueStatusDeps): Promise<QueueStatusResult> {
  const f = find(req.slug, req.id, deps);
  if ('status' in f && 'body' in f) return f;
  if (f.queue.version !== req.version) {
    return { status: 409, body: { error: 'The review queue changed since this page loaded it, so nothing was run. This is the current version.', current: f.queue } };
  }
  return runInRepo(f, ['status', req.id, req.status], 'status', req.dryRun, deps, (run, command) => {
    const now = queueNow(f.p);
    const shown = now?.items.find((i) => i.id === req.id)?.status;
    if (shown !== req.status) {
      return { status: 500, body: { error: `The command finished, but the queue ${shown ? `still shows "${shown}"` : "couldn't be read afterwards"}`, output: run.output, command } };
    }
    return { status: 200, body: { ok: true, command, output: run.output, queue: now } };
  });
}

/**
 * Approves a pending shorter draft. The hash comes from the page (the draft as
 * it was shown); Career HQ refuses it if the draft has changed since. Confirms
 * the fill sheet no longer shows a draft for that question.
 */
export async function approveDraft(req: ApproveDraftRequest, deps: QueueStatusDeps): Promise<QueueStatusResult> {
  const f = find(req.slug, req.id, deps);
  if ('status' in f && 'body' in f) return f;
  return runInRepo(f, ['approve-draft', req.id, String(req.question), req.sha256], 'approve-draft', req.dryRun, deps, (run, command) => {
    const message = run.stdout.trim().split('\n').filter(Boolean).at(-1) ?? 'Draft approved.';
    const now = queueNow(f.p);
    const item = now?.items.find((i) => i.id === req.id);
    let stillThere = true;
    try {
      stillThere = !!item && fillSheetFor(f.root, item).parts.some((part) => part.type === 'field' && part.draft?.question === req.question);
    } catch {
      stillThere = true;
    }
    if (stillThere) return { status: 500, body: { error: 'The command finished, but the fill sheet still shows that draft (or couldn\'t be read)', output: run.output, command } };
    return { status: 200, body: { ok: true, command, message, output: run.output, queue: now } };
  });
}

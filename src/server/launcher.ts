// One-click launch (SPEC.md, "The one-click actions"). Requests name things by
// id or slug only; every path, URL and argument is looked up and built here,
// so the page can never choose what gets run.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execa } from 'execa';
import { z } from 'zod';
import { TERMINAL_APP, EDITOR_APP } from './config.ts';
import type { Project, Session } from './db/schema.ts';

// Session and chat ids are UUIDs; anything else is refused before it gets near a shell.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');
const slug = z.string().min(1);
const dryRun = z.boolean().optional();

export const launchRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: uuid, dryRun }),
  z.object({ kind: z.literal('desktop'), sessionId: uuid, dryRun }),
  z.object({ kind: z.literal('new-session'), slug, path: z.string().optional(), dryRun }),
  z.object({ kind: z.literal('chat'), chatId: uuid, in: z.enum(['desktop', 'browser']).optional(), dryRun }),
  z.object({ kind: z.literal('claude-project'), slug, in: z.enum(['desktop', 'browser']).optional(), dryRun }),
  z.object({ kind: z.literal('editor'), slug, path: z.string().optional(), dryRun }),
  z.object({ kind: z.literal('from-pr'), slug, pr: z.number().int().positive(), path: z.string().optional(), dryRun }),
]);

export type LaunchRequest = z.infer<typeof launchRequestSchema>;

/**
 * What to run. `terminal` opens a new terminal window in `cwd` running `argv`;
 * `open` runs macOS `open` with `argv`; `direct` runs `argv` in `cwd` with no window.
 */
export type LaunchPlan =
  | { via: 'terminal'; cwd: string; argv: string[] }
  | { via: 'open'; argv: string[] }
  | { via: 'direct'; cwd: string; argv: string[] };

export class LaunchError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export type LaunchLookup = {
  session: (id: string) => Session | undefined;
  project: (slug: string) => Project | undefined;
  /** Chats open in the Claude desktop app unless the request says otherwise. */
  claudeDesktopInstalled: boolean;
  exists: (p: string) => boolean;
};

const PROJECT_URL = /^https:\/\/claude\.ai\/project\/([0-9a-f-]{36})\/?$/i;

/** Turns a request into a plan. Pure apart from the lookups, so it is unit-tested. */
export function planLaunch(req: LaunchRequest, look: LaunchLookup): LaunchPlan {
  const folder = (p: string) => {
    if (!look.exists(p)) throw new LaunchError(409, `Folder no longer exists: ${p}`);
    return p;
  };
  const session = (id: string) => {
    const s = look.session(id);
    if (!s) throw new LaunchError(404, `Unknown session ${id}`);
    return s;
  };
  const project = (s: string) => {
    const p = look.project(s);
    if (!p) throw new LaunchError(404, `Unknown project ${s}`);
    return p;
  };
  // A path in the request must be one the project already lists.
  const pick = (choices: string[], wanted: string | undefined, what: string) => {
    if (wanted !== undefined) {
      if (!choices.includes(wanted)) throw new LaunchError(400, `${wanted} is not one of this project's ${what}`);
      return folder(wanted);
    }
    if (choices.length === 0) throw new LaunchError(409, `This project has no ${what} in projects.yaml`);
    return folder(choices[0]);
  };
  const claudeUrl = (pathname: string, where: 'desktop' | 'browser' | undefined) =>
    (where ?? (look.claudeDesktopInstalled ? 'desktop' : 'browser')) === 'desktop'
      ? `claude://claude.ai/${pathname}`
      : `https://claude.ai/${pathname}`;

  switch (req.kind) {
    case 'session': {
      const s = session(req.sessionId);
      return { via: 'terminal', cwd: folder(s.cwd), argv: ['claude', '--resume', s.id] };
    }
    case 'desktop': {
      const s = session(req.sessionId);
      return { via: 'direct', cwd: folder(s.cwd), argv: ['claude', '--desktop', '--resume', s.id] };
    }
    case 'new-session': {
      const repo = pick(project(req.slug).repos, req.path, 'repos');
      return { via: 'open', argv: ['open', `claude-cli://open?cwd=${encodeURIComponent(repo)}`] };
    }
    case 'chat':
      return { via: 'open', argv: ['open', claudeUrl(`chat/${req.chatId}`, req.in)] };
    case 'claude-project': {
      const p = project(req.slug);
      const id = p.claudeProject?.match(PROJECT_URL)?.[1];
      if (!id) throw new LaunchError(409, 'This project has no claude_project link in projects.yaml');
      return { via: 'open', argv: ['open', claudeUrl(`project/${id}`, req.in)] };
    }
    case 'editor': {
      const p = project(req.slug);
      return { via: 'open', argv: ['open', '-a', EDITOR_APP, pick([...p.repos, ...p.folders], req.path, 'repos or folders')] };
    }
    case 'from-pr': {
      const repo = pick(project(req.slug).repos, req.path, 'repos');
      return { via: 'terminal', cwd: repo, argv: ['claude', '--from-pr', String(req.pr)] };
    }
  }
}

/** Quotes for sh/zsh: plain words stay bare, anything else goes in single quotes. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const line = (argv: string[]) => argv.map(shellQuote).join(' ');

/** The exact command a plan runs, as you would type it. */
export function describePlan(plan: LaunchPlan): string {
  switch (plan.via) {
    case 'terminal':
      return `cd ${shellQuote(plan.cwd)} && ${line(plan.argv)}   (in a new ${TERMINAL_APP} window)`;
    case 'open':
      return line(plan.argv);
    case 'direct':
      return `cd ${shellQuote(plan.cwd)} && ${line(plan.argv)}`;
  }
}

/** The script a terminal plan writes. It deletes itself, then replaces itself with the command. */
export function commandFile(plan: { cwd: string; argv: string[] }): string {
  return `#!/bin/sh
# Written by Project Hub for one launch; removes itself when it runs.
rm -f -- "$0"
cd ${shellQuote(plan.cwd)} || exit 1
exec ${line(plan.argv)}
`;
}

const run = promisify(execFile);
const STALE_MS = 60 * 60_000;

/** Runs plans on macOS. Terminal launches go through a .command file, which needs no Automation permission. */
export function macLauncher(launchDir: string) {
  return async function launch(plan: LaunchPlan): Promise<void> {
    switch (plan.via) {
      case 'terminal': {
        fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
        // Sweep files from launches whose window never ran them.
        for (const f of fs.readdirSync(launchDir)) {
          const p = path.join(launchDir, f);
          if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true });
        }
        const file = path.join(launchDir, `launch-${crypto.randomBytes(6).toString('hex')}.command`);
        fs.writeFileSync(file, commandFile(plan), { mode: 0o700, flag: 'wx' });
        await run('/usr/bin/open', ['-a', TERMINAL_APP, file]);
        return;
      }
      case 'open':
        await run('/usr/bin/open', plan.argv.slice(1));
        return;
      case 'direct':
        await execa(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, stdin: 'ignore', timeout: 30_000 });
        return;
    }
  };
}

export type Launcher = (plan: LaunchPlan) => Promise<void>;

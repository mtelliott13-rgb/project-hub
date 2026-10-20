// Monetize > Generate (SPEC.md, Phase 4): runs Claude Code headless in the
// project's folder to draft how the project could make money. Only when you
// click Generate. Claude may read the project's folders and search the web,
// and nothing else: no edits, no shell, no MCP servers, no user settings (so
// no hooks fire), and no saved transcript.
import fs from 'node:fs';
import { execa } from 'execa';
import { z } from 'zod';

export const MONETIZE_HEADINGS = [
  'Who would pay',
  "What they'd pay for",
  'Pricing ideas',
  'What it would take to get there',
  'First 3 steps',
];

export const READ_AND_WEB_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

export function monetizePrompt(p: { name: string; keywords: string[] }, dirs: string[]): string {
  return `You are drafting a plan for how the project "${p.name}" could make money.${
    p.keywords.length ? ` Its keywords are: ${p.keywords.join(', ')}.` : ''
  }

${
  dirs.length
    ? `Read the project's files to learn what it is and how far along it is. Its folders: ${dirs.join(', ')}.`
    : 'It has no folders yet, so work from its name and keywords.'
} Use web search to check comparable products and what they charge. Do not change any files.

Reply with only the draft, in Markdown, using exactly these headings in this order:

${MONETIZE_HEADINGS.map((h) => `## ${h}`).join('\n')}

Be concrete and specific to this project. Under "First 3 steps" give exactly three numbered steps. Link any comparable you mention.`;
}

export type MonetizeCommand = { cwd: string; argv: string[] };

/**
 * The exact command. It runs in the first repo (else the first folder) that
 * exists; the project's other existing folders are added with --add-dir.
 * `fallbackCwd` is used when none exist.
 */
export function monetizeCommand(
  p: { name: string; keywords: string[]; repos: string[]; folders: string[] },
  exists: (dir: string) => boolean,
  fallbackCwd: string,
): MonetizeCommand {
  const dirs = [...p.repos, ...p.folders].filter(exists);
  const [cwd = fallbackCwd, ...more] = dirs;
  return {
    cwd,
    argv: [
      'claude',
      '-p',
      monetizePrompt(p, dirs),
      '--restricted',
      '--tools',
      READ_AND_WEB_TOOLS.join(','),
      '--allowedTools',
      ...READ_AND_WEB_TOOLS,
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format',
      'json',
      ...more.flatMap((d) => ['--add-dir', d]),
    ],
  };
}

const resultSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
});

export type MonetizeResult = { text: string; costUsd: number | null };

/**
 * Runs the command and returns the draft. Throws with a readable reason.
 * `pids` holds the process id while it runs, so the `claude agents` poll can
 * tell this run apart from your own sessions.
 */
export async function runMonetize(cmd: MonetizeCommand, pids: Set<number>, timeoutMs = 10 * 60_000): Promise<MonetizeResult> {
  if (!fs.existsSync(cmd.cwd)) fs.mkdirSync(cmd.cwd, { recursive: true });
  const [bin, ...args] = cmd.argv;
  const child = execa(bin, args, { cwd: cmd.cwd, stdin: 'ignore', timeout: timeoutMs });
  const pid = child.pid;
  if (pid !== undefined) pids.add(pid);
  let stdout: string;
  try {
    ({ stdout } = await child);
  } finally {
    if (pid !== undefined) pids.delete(pid);
  }
  const out = resultSchema.parse(JSON.parse(stdout));
  if (out.is_error || !out.result?.trim()) throw new Error(out.result?.trim() || 'Claude returned no draft');
  return { text: out.result.trim() + '\n', costUsd: out.total_cost_usd ?? null };
}

export type MonetizeJob = { state: 'running'; startedAt: string } | { state: 'failed'; error: string; at: string };

/** At most one Generate per project at a time; results land via `onDone`. */
export function monetizeJobs(
  run: (slug: string) => Promise<MonetizeResult>,
  onDone: (slug: string, result: MonetizeResult) => void,
  onChange: () => void,
) {
  const jobs = new Map<string, MonetizeJob>();
  return {
    get: (slug: string) => jobs.get(slug) ?? null,
    /** Returns false if one is already running for this project. */
    start(slug: string): boolean {
      if (jobs.get(slug)?.state === 'running') return false;
      jobs.set(slug, { state: 'running', startedAt: new Date().toISOString() });
      onChange();
      run(slug)
        .then((result) => {
          onDone(slug, result);
          jobs.delete(slug);
        })
        .catch((e: unknown) => {
          const error = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e);
          jobs.set(slug, { state: 'failed', error, at: new Date().toISOString() });
        })
        .finally(onChange);
      return true;
    },
  };
}

export type MonetizeJobs = ReturnType<typeof monetizeJobs>;

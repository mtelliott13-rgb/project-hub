// A project's collector (projects.yaml `collector:`), e.g. a data collector app:
// whether it's running, and plans to start or stop it. Starting and stopping
// go through POST /api/launch with the Phase 2 safeguards; requests name only
// the project, and the command, folder and process all come from here.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Project } from './db/schema.ts';
import { LaunchError, type LaunchPlan } from './launcher.ts';
import type { CollectorConfig } from './projects.ts';

/** POST /api/launch kinds for a collector. The request names only the project. */
export const collectorLaunchSchema = z.object({
  kind: z.enum(['collector-start', 'collector-stop']),
  slug: z.string().min(1),
  dryRun: z.boolean().optional(),
});

export type Listener = { pid: number; cwd: string | null; command: string; startedAt: string | null };

/** How the hub looks at processes. Tests pass a fake. */
export type ProcessProbe = {
  /** Processes listening on a local TCP port. */
  listeners: (port: number) => Promise<Listener[]>;
};

const run = promisify(execFile);
const quiet = async (file: string, args: string[]) => {
  try {
    return (await run(file, args, { timeout: 5000 })).stdout;
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? ''; // lsof exits 1 when nothing matches
  }
};

/** macOS: lsof for the listener and its working folder, ps for its command and start time. */
export const macProbe: ProcessProbe = {
  async listeners(port) {
    const pids = [...new Set((await quiet('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])).match(/^p\d+$/gm) ?? [])].map(
      (p) => Number(p.slice(1)),
    );
    return Promise.all(
      pids.map(async (pid) => {
        const cwd = (await quiet('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).match(/^n(.+)$/m)?.[1] ?? null;
        const command = (await quiet('/bin/ps', ['-o', 'command=', '-p', String(pid)])).trim();
        const started = Date.parse((await quiet('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])).trim());
        return { pid, cwd, command, startedAt: Number.isNaN(started) ? null : new Date(started).toISOString() };
      }),
    );
  },
};

/** The folder the collector runs in: the project's first repo. */
export function collectorDir(p: Pick<Project, 'repos' | 'slug'>): string {
  const dir = p.repos[0];
  if (!dir) throw new LaunchError(409, `${p.slug} has a collector but no repo to run it in`);
  return dir;
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

export type CollectorProcess =
  | { state: 'running'; pid: number; command: string; startedAt: string | null }
  | { state: 'stopped' }
  /** Something else holds the port, so Start would fail. */
  | { state: 'port-busy'; pid: number; command: string };

/** Running means: listening on the port, from inside the project's repo. */
export async function findCollector(cfg: CollectorConfig, dir: string, probe: ProcessProbe): Promise<CollectorProcess> {
  const listeners = await probe.listeners(cfg.port);
  const ours = listeners.find((l) => l.cwd !== null && inside(l.cwd, dir));
  if (ours) return { state: 'running', pid: ours.pid, command: ours.command, startedAt: ours.startedAt };
  if (listeners[0]) return { state: 'port-busy', pid: listeners[0].pid, command: listeners[0].command };
  return { state: 'stopped' };
}

// Only the fields the page shows; the rest of the app's status payload, and any
// source entry that doesn't look like one, is ignored.
const sourceSchema = z.object({
  label: z.string().optional(),
  status: z.string().optional(),
  last_success: z.number().nullable().optional().catch(null),
  last_error: z.string().nullable().optional().catch(null),
});
const statusSchema = z.object({ sources: z.record(z.string(), z.unknown()) });

export type SourceHealth = { id: string; label: string; status: string; lastSuccess: string | null; lastError: string | null };

/** Reads the app's own status endpoint, if it has one. Never throws. */
export async function sourceHealth(url: string | undefined, fetcher: typeof fetch = fetch): Promise<{ sources: SourceHealth[] | null; error: string | null }> {
  if (!url) return { sources: null, error: null };
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { sources: null, error: `${url} answered ${res.status}` };
    const parsed = statusSchema.parse(await res.json());
    return {
      error: null,
      sources: Object.entries(parsed.sources).flatMap(([id, raw]) => {
        const s = sourceSchema.safeParse(raw);
        return s.success ? [{ id, ...s.data }] : [];
      }).map(({ id, ...s }) => ({
        id,
        label: s.label ?? id,
        status: s.status ?? 'unknown',
        lastSuccess: s.last_success ? new Date(s.last_success * 1000).toISOString() : null,
        lastError: s.last_error ?? null,
      })),
    };
  } catch (e) {
    return { sources: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Start opens a terminal running the configured command, refused while one is running (one copy only). */
export async function planCollectorStart(p: Project, probe: ProcessProbe): Promise<LaunchPlan> {
  const cfg = p.collector;
  if (!cfg) throw new LaunchError(409, `${p.name} has no collector in projects.yaml`);
  const dir = collectorDir(p);
  const found = await findCollector(cfg, dir, probe);
  if (found.state === 'running') throw new LaunchError(409, `The collector is already running (process ${found.pid}). Only one copy should run.`);
  if (found.state === 'port-busy') {
    throw new LaunchError(409, `Port ${cfg.port} is in use by another program (process ${found.pid}: ${found.command}), so the collector can't start`);
  }
  return { via: 'terminal', cwd: dir, argv: cfg.command };
}

/** Stop sends Ctrl+C's signal to the collector's own process, and nothing else. */
export async function planCollectorStop(p: Project, probe: ProcessProbe): Promise<LaunchPlan> {
  const cfg = p.collector;
  if (!cfg) throw new LaunchError(409, `${p.name} has no collector in projects.yaml`);
  const found = await findCollector(cfg, collectorDir(p), probe);
  if (found.state !== 'running') throw new LaunchError(409, "The collector isn't running");
  return { via: 'signal', pid: found.pid, signal: 'SIGINT', what: `${p.name}'s collector: ${found.command}` };
}

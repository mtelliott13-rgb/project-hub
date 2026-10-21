// Meme Radar's collector: status, Start and Stop. Fake processes only; no test
// touches a real collector.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { findCollector, planCollectorStart, planCollectorStop, sourceHealth, type Listener } from '../src/server/collector.ts';
import { MIGRATIONS_DIR } from '../src/server/config.ts';
import { listAllProjects, openDb } from '../src/server/db/index.ts';
import { describePlan, signalAndWait } from '../src/server/launcher.ts';
import { updateProject } from '../src/server/projects-file.ts';
import { parseProjects } from '../src/server/projects.ts';
import { HUB, PAGE_GET, testDeps } from './helpers.ts';

const COMMAND = ['caffeinate', '-i', 'uv', 'run', 'python', '-m', 'radar'];
const yaml = (repo: string) => `projects:
  - slug: meme-radar
    name: Meme Radar
    repos: [${repo}]
    collector:
      command: [${COMMAND.join(', ')}]
      port: 8000
      status_url: http://127.0.0.1:8000/api/status

  - slug: plain
    name: Plain
`;

const ours = (repo: string): Listener => ({ pid: 4242, cwd: repo, command: 'Python -m radar', startedAt: '2026-10-20T20:47:48.000Z' });
const stranger: Listener = { pid: 999, cwd: '/somewhere/else', command: 'node server.js', startedAt: null };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hub-test-'));
  dirs.push(dir);
  const repo = path.join(dir, 'meme-radar');
  fs.mkdirSync(repo);
  const db = openDb(path.join(dir, 'hub.db'), MIGRATIONS_DIR);
  const t = testDeps(db);
  fs.writeFileSync(t.projectsFile, yaml(repo));
  t.store.reload();
  const status = { sources: { pumpportal: { label: 'PumpPortal (new tokens)', status: 'ok', last_success: 1792608598, last_error: null }, extra: 1 }, counts: {} };
  const fetcher = (async () => new Response(JSON.stringify(status))) as typeof fetch;
  const app = createApp({ ...t.deps, fetcher });
  const page = { Origin: HUB, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Hub-Token': 'ui-t0ken' };
  const launch = async (body: unknown, headers: Record<string, string> = page) => {
    const res = await app.request(`${HUB}/api/launch`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const collectorStatus = async () => (await app.request(`${HUB}/api/projects/meme-radar/collector`, { headers: PAGE_GET })).json();
  const project = () => listAllProjects(db).find((p) => p.slug === 'meme-radar')!;
  return { t, repo, app, launch, collectorStatus, project, probe: t.deps.probe };
}

describe('collector config', () => {
  it('reads collector: from projects.yaml, and the Edit form leaves it alone', () => {
    const [p] = parseProjects(yaml('/u/meme-radar'));
    expect(p.collector).toEqual({ command: COMMAND, port: 8000, status_url: 'http://127.0.0.1:8000/api/status' });
    const edited = updateProject(yaml('/u/meme-radar'), 'meme-radar', {
      name: 'Meme Radar',
      repos: ['/u/meme-radar'],
      folders: [],
      github: [],
      claude_project: null,
      keywords: ['memes'],
    });
    expect(parseProjects(edited)[0].collector).toEqual(p.collector);
  });

  it('rejects a collector without a command or with a bad port', () => {
    expect(() => parseProjects('projects:\n  - slug: x\n    name: X\n    collector: { command: [], port: 8000 }\n')).toThrow();
    expect(() => parseProjects('projects:\n  - slug: x\n    name: X\n    collector: { command: [a], port: 70000 }\n')).toThrow();
  });
});

describe('is it running?', () => {
  it('running only when a process in the repo listens on the port', async () => {
    const { t, repo, probe, project } = setup();
    const cfg = project().collector!;
    expect(await findCollector(cfg, repo, probe)).toEqual({ state: 'stopped' });
    t.listening.set(8000, [stranger]);
    expect(await findCollector(cfg, repo, probe)).toEqual({ state: 'port-busy', pid: 999, command: 'node server.js' });
    t.listening.set(8000, [stranger, { ...ours(repo), cwd: path.join(repo, 'radar') }]);
    expect(await findCollector(cfg, repo, probe)).toMatchObject({ state: 'running', pid: 4242 });
    // A sibling folder whose name starts the same is not the repo.
    t.listening.set(8000, [{ ...ours(repo), cwd: `${repo}-backups` }]);
    expect(await findCollector(cfg, repo, probe)).toMatchObject({ state: 'port-busy' });
  });

  it("reads the app's source health and never throws", async () => {
    const ok = (async () => new Response(JSON.stringify({ sources: { a: { label: 'A', status: 'degraded', last_success: 0 } } }))) as typeof fetch;
    expect(await sourceHealth('http://x/status', ok)).toEqual({
      error: null,
      sources: [{ id: 'a', label: 'A', status: 'degraded', lastSuccess: null, lastError: null }],
    });
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    expect(await sourceHealth('http://x/status', down)).toEqual({ sources: null, error: 'connect ECONNREFUSED' });
    expect(await sourceHealth(undefined, down)).toEqual({ sources: null, error: null });
  });
});

describe('Start and Stop plans', () => {
  it('Start opens a terminal in the repo running the configured command, only when stopped', async () => {
    const { t, repo, probe, project } = setup();
    const plan = await planCollectorStart(project(), probe);
    expect(plan).toEqual({ via: 'terminal', cwd: repo, argv: COMMAND });
    expect(describePlan(plan)).toBe(`cd ${repo} && caffeinate -i uv run python -m radar   (in a new Terminal window)`);

    t.listening.set(8000, [ours(repo)]);
    await expect(planCollectorStart(project(), probe)).rejects.toThrow(/already running \(process 4242\)\. Only one copy/);
    t.listening.set(8000, [stranger]);
    await expect(planCollectorStart(project(), probe)).rejects.toThrow(/Port 8000 is in use by another program/);
  });

  it('Stop signals only the collector process, as Ctrl+C would', async () => {
    const { t, repo, probe, project } = setup();
    await expect(planCollectorStop(project(), probe)).rejects.toThrow(/isn't running/);
    t.listening.set(8000, [stranger]);
    await expect(planCollectorStop(project(), probe)).rejects.toThrow(/isn't running/);
    t.listening.set(8000, [stranger, ours(repo)]);
    const plan = await planCollectorStop(project(), probe);
    expect(plan).toEqual({ via: 'signal', pid: 4242, signal: 'SIGINT', what: "Meme Radar's collector: Python -m radar" });
    expect(describePlan(plan)).toBe("kill -INT 4242   (the same as Ctrl+C, to Meme Radar's collector: Python -m radar)");
  });

  it('signalAndWait returns once the process exits, and says so if it does not', async () => {
    const child = spawn('/bin/sleep', ['30']);
    await signalAndWait(child.pid!, 'SIGINT', 5000);
    expect(child.exitCode !== null || child.signalCode !== null || child.killed).toBeTruthy();

    // A process that ignores SIGINT: report it rather than pretend it stopped.
    const stubborn = spawn('/bin/sh', ['-c', 'trap "" INT; sleep 30']);
    await new Promise((r) => setTimeout(r, 200));
    await expect(signalAndWait(stubborn.pid!, 'SIGINT', 600)).rejects.toThrow(/still running after 0.6 seconds/);
    stubborn.kill('SIGKILL');
  });
});

describe('through /api/launch, with the Phase 2 safeguards', () => {
  it('dry runs show the exact commands without running anything', async () => {
    const { t, repo, launch } = setup();
    expect((await launch({ kind: 'collector-start', slug: 'meme-radar', dryRun: true })).body).toEqual({
      ok: true,
      dryRun: true,
      command: `cd ${repo} && caffeinate -i uv run python -m radar   (in a new Terminal window)`,
    });
    t.listening.set(8000, [ours(repo)]);
    expect((await launch({ kind: 'collector-stop', slug: 'meme-radar', dryRun: true })).body.command).toMatch(/^kill -INT 4242 /);
    expect(t.launched).toEqual([]);
  });

  it('Start and Stop run their plans; repeats and projects without a collector are refused', async () => {
    const { t, repo, launch } = setup();
    expect((await launch({ kind: 'collector-start', slug: 'meme-radar' })).status).toBe(200);
    expect(t.launched).toEqual([{ via: 'terminal', cwd: repo, argv: COMMAND }]);
    t.listening.set(8000, [ours(repo)]);
    expect((await launch({ kind: 'collector-start', slug: 'meme-radar' })).status).toBe(409);
    expect((await launch({ kind: 'collector-stop', slug: 'meme-radar' })).status).toBe(200);
    expect(t.launched.at(-1)).toMatchObject({ via: 'signal', pid: 4242 });
    expect((await launch({ kind: 'collector-stop', slug: 'plain' })).body.error).toMatch(/no collector/);
    expect((await launch({ kind: 'collector-stop', slug: 'nope' })).status).toBe(404);
    expect(t.launched).toHaveLength(2);
  });

  it('refuses anything that is not the hub page with its token, and never takes a command or pid from the request', async () => {
    const { t, repo, launch } = setup();
    t.listening.set(8000, [ours(repo)]);
    const body = { kind: 'collector-stop', slug: 'meme-radar' };
    const ct = { 'Content-Type': 'application/json' };
    for (const headers of [
      { ...ct, 'X-Hub-Token': 'ui-t0ken' }, // no Origin (curl, scripts)
      { ...ct, Origin: 'https://evil.example', 'X-Hub-Token': 'ui-t0ken' },
      { ...ct, Origin: HUB }, // no token
      { ...ct, Origin: HUB, 'X-Hub-Token': 't0ken' }, // the hook token
      { 'Content-Type': 'text/plain', Origin: HUB, 'X-Hub-Token': 'ui-t0ken' }, // a form post
      { ...ct, Origin: HUB, 'Sec-Fetch-Site': 'cross-site', 'X-Hub-Token': 'ui-t0ken' },
    ]) {
      expect((await launch(body, headers)).status).toBe(403);
    }
    // Extra fields can't steer it: the pid and command come from the hub, not the request.
    const steered = await launch({ ...body, pid: 1, command: ['rm', '-rf', '~'] });
    expect(steered.status).toBe(200);
    expect(t.launched).toEqual([{ via: 'signal', pid: 4242, signal: 'SIGINT', what: "Meme Radar's collector: Python -m radar" }]);
  });

  it('status says running with source health, or starting after Start, or stopped', async () => {
    const { t, repo, launch, collectorStatus, app } = setup();
    expect(await collectorStatus()).toMatchObject({ state: 'stopped', port: 8000, sources: null });
    await launch({ kind: 'collector-start', slug: 'meme-radar' });
    expect(await collectorStatus()).toMatchObject({ state: 'starting' });
    t.listening.set(8000, [ours(repo)]);
    expect(await collectorStatus()).toMatchObject({
      state: 'running',
      pid: 4242,
      startedAt: '2026-10-20T20:47:48.000Z',
      sources: [{ id: 'pumpportal', label: 'PumpPortal (new tokens)', status: 'ok' }],
    });
    expect((await app.request(`${HUB}/api/projects/plain/collector`, { headers: PAGE_GET })).status).toBe(404);
    expect((await app.request(`${HUB}/api/projects/meme-radar/collector`)).status).toBe(403);
  });
});

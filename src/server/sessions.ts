import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { and, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/index.ts';
import { sessions, type Project, type Session } from './db/schema.ts';
import { matchProject } from './matching.ts';

// Only the fields the hub keeps. zod drops every other key, so prompt text or
// Claude's last message never reach the database even if a payload carries them.
export const hookPayloadSchema = z.object({
  session_id: z.string().min(1),
  hook_event_name: z.string(),
  cwd: z.string().min(1),
  transcript_path: z.string().optional(),
  // A plain id string, or an object with an id, depending on the version.
  model: z
    .union([z.string(), z.object({ id: z.string() }).transform((m) => m.id)])
    .optional()
    .catch(undefined),
  reason: z.string().optional(),
});

export type HookPayload = z.infer<typeof hookPayloadSchema>;

/** Records one hook event. Returns false for events the hub ignores. */
export function applyHookEvent(db: Db, e: HookPayload, projects: Project[], now = new Date()): boolean {
  const base = {
    projectSlug: matchProject(e.cwd, projects, e.session_id),
    cwd: e.cwd,
    lastActiveAt: now,
    ...(e.transcript_path && { transcriptPath: e.transcript_path }),
    ...(e.model && { model: e.model }),
  };
  let update: Partial<typeof sessions.$inferInsert>;
  switch (e.hook_event_name) {
    case 'SessionStart':
    case 'Stop':
      update = { ...base, state: 'running', endedAt: null, endReason: null };
      break;
    case 'SessionEnd':
      update = { ...base, state: 'ended', endedAt: now, endReason: e.reason ?? null };
      break;
    default:
      return false;
  }
  db.insert(sessions)
    .values({ id: e.session_id, state: 'running', startedAt: now, ...update } as typeof sessions.$inferInsert)
    .onConflictDoUpdate({ target: sessions.id, set: update })
    .run();
  return true;
}

/**
 * The SDK's summary falls back to the first prompt when a session has no
 * generated title. That would store a prompt, so treat it as no title.
 */
export function titleFromInfo(info: SDKSessionInfo): string | null {
  if (info.customTitle) return info.customTitle;
  const summary = info.summary?.trim();
  if (!summary) return null;
  const prompt = info.firstPrompt?.trim();
  if (prompt) {
    const s = summary.replace(/(…|\.\.\.)$/, '');
    if (prompt.startsWith(s) || s.startsWith(prompt)) return null;
  }
  return summary;
}

/**
 * Backfills sessions the hooks never saw and refreshes titles and branches.
 * Every session the SDK reports has a saved conversation, so it is marked
 * resumable. When `infos` is the SDK's complete listing, sessions missing
 * from it are marked not resumable. Hook-owned fields (state, timestamps of
 * known sessions) are left alone.
 */
export function syncFromSdk(db: Db, infos: SDKSessionInfo[], projects: Project[], opts: { complete?: boolean } = {}): number {
  let changed = 0;
  db.transaction((tx) => {
    for (const info of infos) {
      if (!info.cwd) continue;
      const fresh = { title: titleFromInfo(info), gitBranch: info.gitBranch ?? null, resumable: true };
      const res = tx
        .insert(sessions)
        .values({
          id: info.sessionId,
          projectSlug: matchProject(info.cwd, projects, info.sessionId),
          cwd: info.cwd,
          ...fresh,
          state: 'ended',
          startedAt: info.createdAt ? new Date(info.createdAt) : null,
          lastActiveAt: new Date(info.lastModified),
        })
        .onConflictDoUpdate({ target: sessions.id, set: fresh })
        .run();
      changed += res.changes;
    }
    if (opts.complete) {
      changed += tx
        .update(sessions)
        .set({ resumable: false })
        .where(and(eq(sessions.resumable, true), notInArray(sessions.id, infos.map((i) => i.sessionId))))
        .run().changes;
    }
  });
  return changed;
}

/** A session can be reopened when Claude Code saved its conversation and its folder still exists. */
export function resumeProblem(s: Pick<Session, 'resumable' | 'cwd'>, exists: (dir: string) => boolean): string | null {
  if (!s.resumable) return "Claude Code didn't save a conversation for this session, so it can't be reopened";
  if (!exists(s.cwd)) return `Its folder no longer exists: ${s.cwd}`;
  return null;
}

export const agentSchema = z.object({
  sessionId: z.string(),
  pid: z.number().optional(),
  cwd: z.string(),
  kind: z.string().optional(),
  startedAt: z.number().optional(),
});
export type RunningAgent = z.infer<typeof agentSchema>;

/** Drops the hub's own headless runs (Monetize > Generate), which aren't your sessions. */
export const withoutPids = (agents: RunningAgent[], pids: ReadonlySet<number>) =>
  agents.filter((a) => a.pid === undefined || !pids.has(a.pid));

/**
 * Marks sessions listed by `claude agents --json` as running. A session that
 * was listed before (so has a kind) and is gone now has exited. Sessions only
 * the hooks know about are left to SessionEnd, since the list may not cover
 * every surface.
 */
export function reconcileRunning(db: Db, agents: RunningAgent[], projects: Project[], now = new Date()) {
  db.transaction((tx) => {
    for (const a of agents) {
      const set = { state: 'running' as const, kind: a.kind ?? 'unknown', endedAt: null, endReason: null };
      tx.insert(sessions)
        .values({
          id: a.sessionId,
          projectSlug: matchProject(a.cwd, projects, a.sessionId),
          cwd: a.cwd,
          startedAt: a.startedAt ? new Date(a.startedAt) : now,
          lastActiveAt: now,
          ...set,
        })
        .onConflictDoUpdate({ target: sessions.id, set })
        .run();
    }
    tx.update(sessions)
      .set({ state: 'ended', endedAt: now, endReason: 'exited' })
      .where(
        and(
          eq(sessions.state, 'running'),
          isNotNull(sessions.kind),
          notInArray(sessions.id, agents.map((a) => a.sessionId)),
        ),
      )
      .run();
  });
}

/** Re-files every session after projects.yaml changes. */
export function rematchSessions(db: Db, projects: Project[]) {
  const rows = db.select({ id: sessions.id, cwd: sessions.cwd, slug: sessions.projectSlug }).from(sessions).all();
  db.transaction((tx) => {
    for (const r of rows) {
      const slug = matchProject(r.cwd, projects, r.id);
      if (slug !== r.slug) tx.update(sessions).set({ projectSlug: slug }).where(eq(sessions.id, r.id)).run();
    }
  });
}

export function sessionsForProjects(db: Db, slugs: string[]): Session[] {
  if (slugs.length === 0) return [];
  return db
    .select()
    .from(sessions)
    .where(inArray(sessions.projectSlug, slugs))
    .orderBy(desc(sessions.lastActiveAt))
    .all();
}

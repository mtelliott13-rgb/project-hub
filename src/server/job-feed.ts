// Career HQ's job feed: jobs/feed/feed.json (format in ~/career-hq/SPEC.md
// "Job feed format"). Written only by Career HQ's scripts/job_feed.py; the hub
// only reads it, to list postings and offer "Build packet" (launch-build in
// queue-status.ts). Read fresh on each request, sent no-store, never exposed
// through /agent or the MCP tools.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Application } from './applications.ts';

export const FEED_FILE = 'jobs/feed/feed.json';
/** The real feed is tens of KB; anything this big isn't read. */
const FEED_MAX_BYTES = 5 * 1024 * 1024;
/** Career HQ's own posting id rule (POSTING_RE in scripts/review_queue.py): `<system>:<board>:<job id>`. */
export const POSTING_ID = /^(greenhouse|lever|ashby):[a-z0-9-]+:[A-Za-z0-9-]+$/;

export class FeedError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** feed.json in the project's repos, then folders (the first is used). */
export function findFeedFiles(p: { repos: string[]; folders: string[] }): string[] {
  return [...new Set([...p.repos, ...p.folders])].map((d) => path.join(d, FEED_FILE)).filter((f) => fs.existsSync(f));
}
export const feedCandidates = (dirs: string[]) => dirs.map((d) => path.join(d, FEED_FILE));
/** The repo holding jobs/feed/feed.json (where Career HQ's command runs). */
export const feedRoot = (file: string) => path.resolve(path.dirname(file), '..', '..');

const text = z.preprocess((v) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? String(v) : v), z.string().nullable()).catch(null);
const num = z.number().nullable().catch(null);
const bool = z.boolean().nullable().catch(null);

const postingSchema = z.object({
  id: z.string(),
  company: text,
  title: text,
  location: text,
  level: text,
  location_reason: text,
  url: text,
  apply_url: text,
  source: text,
  posted_on: text,
  first_seen: text,
  age_days: num,
  open_30_plus: bool,
  reposted: num,
  new: bool,
  fit: text,
});

const feedSchema = z.object({
  format: text,
  version: z.unknown().optional(),
  generated: text,
  counts: z.object({ postings: num, new: num, reposted: num }).partial().nullable().catch(null).optional(),
  runs: z.array(z.object({ company: text, ok: bool, fetched: num, error: text }).partial()).catch([]).optional(),
  postings: z.array(z.unknown()),
  not_covered: z.array(z.object({ company: text, uses: text, check_url: text }).partial()).catch([]).optional(),
  attribution: z.array(z.unknown()).catch([]).optional(),
});

export type Posting = {
  id: string;
  /** False when the id isn't Career HQ's `<system>:<board>:<job id>` (shown, never launchable). */
  idOk: boolean;
  company: string;
  title: string;
  location: string | null;
  level: string | null;
  locationReason: string | null;
  url: string | null;
  applyUrl: string | null;
  source: string | null;
  postedOn: string | null;
  firstSeen: string | null;
  ageDays: number | null;
  open30Plus: boolean;
  reposted: number;
  isNew: boolean;
  fit: string | null;
  /** The queue item already built for this posting (its url matches the posting's url or apply_url), if any. */
  packet: string | null;
};

export type Feed = {
  file: string;
  generated: string | null;
  counts: { postings: number; new: number; reposted: number };
  postings: Posting[];
  /** Companies Career HQ couldn't read automatically: "check these by hand". */
  notCovered: { company: string; uses: string | null; checkUrl: string | null }[];
  /** Boards whose last read failed. */
  failedRuns: { company: string; error: string | null }[];
  attribution: string[];
  warnings: string[];
};

const httpUrl = (v: string | null) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};
/** Compared the way Career HQ compares them: ignoring one trailing slash. */
const sameUrl = (u: string) => u.replace(/\/$/, '');

export function parseFeed(raw: string, file: string, queueItems: Pick<Application, 'id' | 'url'>[] = []): Feed {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new FeedError(400, `${path.basename(file)} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const parsed = feedSchema.safeParse(data);
  if (!parsed.success) throw new FeedError(400, `${path.basename(file)} isn't a Career HQ job feed (needs a \`postings\` list)`);
  const f = parsed.data;
  const warnings: string[] = [];
  if (f.format !== 'career-hq job feed') warnings.push(`Unexpected format "${f.format ?? ''}"; shown as best it can be`);
  if (f.version !== 1) warnings.push(`Feed version ${JSON.stringify(f.version ?? null)} is newer than this page knows (1); some fields may be missing`);

  const byUrl = new Map<string, string>();
  for (const q of queueItems) if (q.url) byUrl.set(sameUrl(q.url), q.id);

  const postings: Posting[] = [];
  f.postings.forEach((rawPosting, i) => {
    const p = postingSchema.safeParse(rawPosting);
    if (!p.success) {
      warnings.push(`Posting ${i + 1} has no id, so it's skipped`);
      return;
    }
    const x = p.data;
    const url = httpUrl(x.url);
    const applyUrl = httpUrl(x.apply_url);
    const packet = [url, applyUrl].map((u) => (u ? byUrl.get(sameUrl(u)) : undefined)).find(Boolean) ?? null;
    postings.push({
      id: x.id,
      idOk: x.id.length <= 200 && POSTING_ID.test(x.id),
      company: x.company ?? '(no company)',
      title: x.title ?? '(no title)',
      location: x.location,
      level: x.level,
      locationReason: x.location_reason,
      url,
      applyUrl,
      source: x.source,
      postedOn: x.posted_on,
      firstSeen: x.first_seen,
      ageDays: x.age_days,
      open30Plus: x.open_30_plus === true,
      reposted: x.reposted ?? 0,
      isNew: x.new === true,
      fit: x.fit,
      packet,
    });
  });
  return {
    file,
    generated: f.generated,
    counts: { postings: f.counts?.postings ?? postings.length, new: f.counts?.new ?? 0, reposted: f.counts?.reposted ?? 0 },
    postings,
    notCovered: (f.not_covered ?? []).map((n) => ({ company: n.company ?? '(no company)', uses: n.uses ?? null, checkUrl: httpUrl(n.check_url ?? null) })),
    failedRuns: (f.runs ?? []).filter((r) => r.ok === false).map((r) => ({ company: r.company ?? '(no company)', error: r.error ?? null })),
    attribution: (f.attribution ?? []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))),
    warnings,
  };
}

export function readFeed(file: string, queueItems: Pick<Application, 'id' | 'url'>[] = []): Feed {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new FeedError(404, `${path.basename(file)} is gone`);
  }
  if (size > FEED_MAX_BYTES) throw new FeedError(400, `${path.basename(file)} is over 5 MB, so it isn't read`);
  return parseFeed(fs.readFileSync(file, 'utf8'), file, queueItems);
}

// Job applications: Career HQ's review queue (jobs/queue/review_queue.yaml,
// format in ~/career-hq/SPEC.md "Review queue format") and each packet's
// fill sheet (fill_sheet.md). Career HQ writes the queue; the hub reads it and
// changes one item's `status` (plus `submitted_on`) with the same rules as
// toolkit.yaml: only those characters change, the result is re-parsed and
// checked, a stale page is refused, and the first write per hub run is
// backed up. Everything here is local: never sent anywhere, never exposed
// through the MCP tools.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, isSeq, parse, parseDocument, Scalar, type YAMLMap } from 'yaml';
import { APP_STATUSES, FITS, type AppStatus } from './queue-rules.ts';

export { APP_STATUSES, FITS, queueSummary, sortApplications, type AppStatus } from './queue-rules.ts';

export const QUEUE_FILE = 'jobs/queue/review_queue.yaml';
export const PACKET_FILES = { resume: 'resume.pdf', 'cover-letter': 'cover_letter.pdf' } as const;
export type PacketFile = keyof typeof PACKET_FILES;
const FILL_SHEET = 'fill_sheet.md';

export class QueueError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export type Application = {
  /** Position in `items`; a write names the item by this and its `id`. */
  index: number;
  id: string;
  company: string;
  title: string;
  /** As written; `statusKnown` false means it isn't draft/reviewed/submitted (shown and flagged). */
  status: string;
  statusKnown: boolean;
  fit: string | null;
  fitKnown: boolean;
  location: string | null;
  /** Only http/https links. */
  url: string | null;
  added: string | null;
  deadline: string | null;
  submittedOn: string | null;
  packet: string | null;
  notes: string | null;
  /** Which packet files exist (only inside the repo; see packetDir). */
  files: { resume: boolean; coverLetter: boolean; fillSheet: boolean };
  /** Missing required fields and the like, shown on the card. */
  problems: string[];
};

export type Queue = {
  file: string;
  /** sha256 of the file's bytes; a write must name the version the page loaded. */
  version: string;
  items: Application[];
  counts: Record<AppStatus, number>;
  /** Items that couldn't be read at all (no id), by position. */
  problems: string[];
};

const versionOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' || typeof v === 'object' ? null : String(v));
const httpUrl = (v: string | null) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/** The queue file in the project's repos, then folders (the first one wins). */
export function findQueueFiles(p: { repos: string[]; folders: string[] }): string[] {
  return [...new Set([...p.repos, ...p.folders])].map((d) => path.join(d, QUEUE_FILE)).filter((f) => fs.existsSync(f));
}

/** The folder the queue's paths are relative to: the repo holding jobs/queue/. */
export const queueRoot = (file: string) => path.resolve(path.dirname(file), '..', '..');

/**
 * A packet folder, only if it resolves (symlinks followed) to somewhere inside
 * the repo that holds the queue. Anything else is null: an absolute path
 * elsewhere, `..`, or a link pointing out.
 */
export function packetDir(root: string, packet: string | null): string | null {
  if (!packet) return null;
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.resolve(root, packet));
  } catch {
    return null;
  }
  return real.startsWith(realRoot + path.sep) && fs.statSync(real).isDirectory() ? real : null;
}

/** A packet file (resume.pdf, cover_letter.pdf, fill_sheet.md) inside the repo, or null. */
export function packetFile(root: string, packet: string | null, name: string): string | null {
  const dir = packetDir(root, packet);
  if (!dir) return null;
  const f = path.join(dir, name);
  try {
    const real = fs.realpathSync(f);
    return real.startsWith(dir + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function parseQueue(text: string, file: string): Queue {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new QueueError(400, `${path.basename(file)} is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  const list = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) throw new QueueError(400, `${path.basename(file)} needs a top-level \`items:\` list`);
  const root = queueRoot(file);
  const items: Application[] = [];
  const problems: string[] = [];
  list.forEach((raw, index) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const id = str(it.id);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !id) {
      problems.push(`Item ${index + 1} has no id, so it's skipped`);
      return;
    }
    const issues: string[] = [];
    for (const k of ['company', 'title', 'status', 'added', 'packet']) if (!str(it[k])) issues.push(`missing ${k}`);
    const status = str(it.status) ?? 'draft';
    const statusKnown = (APP_STATUSES as readonly string[]).includes(status);
    if (str(it.status) && !statusKnown) issues.push(`unknown status "${status}"`);
    const fit = str(it.fit);
    const fitKnown = !fit || (FITS as readonly string[]).includes(fit);
    if (!fitKnown) issues.push(`unknown fit "${fit}"`);
    if (str(it.url) && !httpUrl(str(it.url))) issues.push('url is not an http(s) link');
    const packet = str(it.packet);
    if (packet && !packetDir(root, packet)) issues.push(`packet folder not found inside ${path.basename(root)}: ${packet}`);
    items.push({
      index,
      id,
      company: str(it.company) ?? '(no company)',
      title: str(it.title) ?? '(no title)',
      status,
      statusKnown,
      fit,
      fitKnown,
      location: str(it.location),
      url: httpUrl(str(it.url)),
      added: str(it.added),
      deadline: str(it.deadline),
      submittedOn: str(it.submitted_on),
      packet,
      notes: str(it.notes),
      files: {
        resume: !!packetFile(root, packet, PACKET_FILES.resume),
        coverLetter: !!packetFile(root, packet, PACKET_FILES['cover-letter']),
        fillSheet: !!packetFile(root, packet, FILL_SHEET),
      },
      problems: issues,
    });
  });
  const counts = { draft: 0, reviewed: 0, submitted: 0 };
  for (const i of items) if (i.statusKnown) counts[i.status as AppStatus]++;
  return { file, version: versionOf(text), items, counts, problems };
}

export const readQueue = (file: string) => parseQueue(fs.readFileSync(file, 'utf8'), file);

/** Written the way the file already writes that value (SPEC.md: every string in double quotes). */
function scalarText(value: string, type: Scalar['type'] | undefined) {
  if (type === Scalar.QUOTE_SINGLE) return `'${value}'`;
  if (type === Scalar.PLAIN) return value;
  return JSON.stringify(value);
}

/**
 * Sets item `index`'s status, changing only that value's characters. Moving to
 * `submitted` adds `submitted_on: "<today>"` if there is none; moving away from
 * it removes the `submitted_on` line (SPEC.md: set only when submitted).
 * Refuses if the item at `index` isn't `id`, then parses the result and
 * checks nothing else changed.
 */
export function setQueueStatus(text: string, index: number, id: string, status: AppStatus, today: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new QueueError(400, `The queue is not valid YAML: ${doc.errors[0].message}`);
  const seq = doc.get('items', true);
  if (!isSeq(seq)) throw new QueueError(400, 'The queue needs a top-level `items:` list');
  const item = seq.items[index];
  if (!isMap(item) || str(item.get('id')) !== id) throw new QueueError(409, `Item ${index + 1} is no longer "${id}"; the file has changed`);
  if (item.flow || !item.range) throw new QueueError(400, `"${id}" is written on one line ({…}); change it by hand`);
  const statusNode = (item as YAMLMap).get('status', true);
  if (!isScalar(statusNode) || !statusNode.range) throw new QueueError(400, `"${id}" has no plain status value to change`);
  const submittedPair = (item as YAMLMap).items.find((pair) => isScalar(pair.key) && pair.key.value === 'submitted_on');

  // Edits as [start, end, replacement], applied from the end so ranges stay valid.
  const edits: [number, number, string][] = [[statusNode.range[0], statusNode.range[1], scalarText(status, statusNode.type)]];
  if (status === 'submitted' && !submittedPair) {
    // A new line right after the status line, at the same indent.
    const keyNode = (item as YAMLMap).items.find((pair) => isScalar(pair.key) && pair.key.value === 'status')!.key as Scalar;
    const lineStart = text.lastIndexOf('\n', keyNode.range![0] - 1) + 1;
    const indent = keyNode.range![0] - lineStart;
    const lineEnd = text.indexOf('\n', statusNode.range[1]);
    const at = lineEnd === -1 ? text.length : lineEnd;
    edits.push([at, at, `\n${' '.repeat(indent)}submitted_on: ${scalarText(today, statusNode.type)}`]);
  } else if (status !== 'submitted' && submittedPair) {
    const key = submittedPair.key as Scalar;
    if (!key.range) throw new QueueError(400, `"${id}" has a submitted_on line the hub can't find`);
    const lineStart = text.lastIndexOf('\n', key.range[0] - 1) + 1;
    const lineEnd = text.indexOf('\n', key.range[0]);
    if (text.slice(lineStart, key.range[0]).trim() !== '') throw new QueueError(400, `"${id}" has submitted_on on a shared line; change it by hand`);
    edits.push([lineStart, lineEnd === -1 ? text.length : lineEnd + 1, '']);
  }
  let out = text;
  for (const [start, end, rep] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + rep + out.slice(end);

  const before = parse(text) as { items: Record<string, unknown>[] };
  let after: { items: Record<string, unknown>[] };
  try {
    after = parse(out);
  } catch {
    throw new QueueError(400, 'Refusing to save: the edited queue would not parse');
  }
  const expected = structuredClone(before);
  const changed: Record<string, unknown> = { ...expected.items[index], status };
  if (status === 'submitted') changed.submitted_on ??= today;
  else delete changed.submitted_on;
  expected.items[index] = changed;
  const sortKeys = (o: unknown): unknown =>
    Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)])) : o;
  if (JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(expected))) {
    throw new QueueError(400, "Refusing to save: the edit would change more than this application's status");
  }
  return out;
}

/** Writes a status if the file is still the version the page loaded (backup on the first write per run). */
export function writeQueueStatus(opts: {
  file: string;
  version: string;
  index: number;
  id: string;
  status: AppStatus;
  backupDir: string;
  backedUp: Set<string>;
  now?: Date;
}): Queue {
  const text = fs.readFileSync(opts.file, 'utf8');
  if (versionOf(text) !== opts.version) {
    throw new QueueError(409, 'The review queue was changed outside the hub since this page loaded it, so your change was not saved. This is the current version.');
  }
  const now = opts.now ?? new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const out = setQueueStatus(text, opts.index, opts.id, opts.status, today);
  if (!opts.backedUp.has(opts.file)) {
    fs.mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(opts.backupDir, `review_queue.${stamp}.yaml`), text, { flag: 'wx', mode: 0o600 });
    opts.backedUp.add(opts.file);
  }
  const mode = fs.statSync(opts.file).mode & 0o777;
  const tmp = `${opts.file}.project-hub-tmp`;
  fs.writeFileSync(tmp, out, { mode });
  fs.renameSync(tmp, opts.file);
  return parseQueue(out, opts.file);
}

// Fill sheets (SPEC.md "Fill sheet"): headings, **Label** lines each followed
// by the value in its own fenced code block, > notes and plain text, kept in
// file order so the page shows them exactly as the sheet lays them out.
export type FillPart =
  | { type: 'heading'; level: number; text: string }
  | { type: 'field'; label: string; hint: string | null; value: string; missing: boolean }
  | { type: 'note'; text: string }
  | { type: 'text'; text: string };

export function parseFillSheet(md: string): { title: string | null; parts: FillPart[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const parts: FillPart[] = [];
  let title: string | null = null;
  let label: { label: string; hint: string | null } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const value: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) value.push(lines[i]);
      const v = value.join('\n');
      parts.push({ type: 'field', label: label?.label ?? '', hint: label?.hint ?? null, value: v, missing: v.trim() === '[not in profile]' || v.trim() === '' });
      label = null;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length === 1 && title === null) title = h[2].trim();
      else parts.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      label = null;
      continue;
    }
    const b = line.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    if (b) {
      label = { label: b[1].trim(), hint: b[2].trim() || null };
      continue;
    }
    if (/^>\s?/.test(line)) {
      const text = line.replace(/^>\s?/, '');
      const last = parts.at(-1);
      if (last?.type === 'note') last.text += `\n${text}`;
      else parts.push({ type: 'note', text });
      continue;
    }
    if (line.trim()) {
      if (label) {
        label.hint = label.hint ? `${label.hint} ${line.trim()}` : line.trim();
        continue;
      }
      const last = parts.at(-1);
      if (last?.type === 'text') last.text += `\n${line}`;
      else parts.push({ type: 'text', text: line });
    }
  }
  return { title, parts };
}

/** A queue item's fill sheet, read from inside the repo only. */
export function readFillSheet(file: string, id: string) {
  const q = readQueue(file);
  const item = q.items.find((i) => i.id === id);
  if (!item) throw new QueueError(404, `"${id}" isn't in the review queue`);
  const f = packetFile(queueRoot(file), item.packet, FILL_SHEET);
  if (!f) throw new QueueError(404, `No ${FILL_SHEET} in ${item.packet ?? 'its packet'}`);
  const sheet = parseFillSheet(fs.readFileSync(f, 'utf8'));
  return { id, company: item.company, role: item.title, sheetTitle: sheet.title, parts: sheet.parts };
}

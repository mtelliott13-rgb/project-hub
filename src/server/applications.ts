// Job applications: Career HQ's review queue (jobs/queue.yaml, or the older
// jobs/queue/review_queue.yaml; format in ~/career-hq/SPEC.md "Review queue
// format") and each packet's fill sheet (fill_sheet.json, falling back to
// fill_sheet.md). Career HQ writes all of these; the hub only reads them.
// Status changes run Career HQ's own command (queue-status.ts). Everything
// here is local: never sent anywhere, never exposed through the MCP tools.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { APP_STATUSES, FITS, limitFlags, OUTCOMES, type AppStatus, type LimitFlags } from './queue-rules.ts';

export { APP_STATUSES, FITS, limitFlags, OUTCOMES, queueSummary, sortApplications, type AppStatus, type LimitFlags } from './queue-rules.ts';

/** Where Career HQ writes the queue, relative to its repo: the current place first, then the older one. */
export const QUEUE_FILES = ['jobs/queue.yaml', 'jobs/queue/review_queue.yaml'] as const;
export const PACKET_FILES = { resume: 'resume.pdf', 'cover-letter': 'cover_letter.pdf' } as const;
/** The cover letter you edit in Word (Career HQ's open-letter command opens it). */
export const LETTER_DOCX = 'cover_letter.docx';
/** The resume you edit in Word (Career HQ's open-resume command opens it). */
export const RESUME_DOCX = 'resume.docx';
/** The queue's `letter` values (SPEC.md "Editing the cover letter in Word"); `edited` means Word edits aren't synced yet. */
export const LETTER_STATES = ['generated', 'edited', 'synced'] as const;
/** The queue's `resume` field (Career HQ's resume_state.py). edited_pdf_outdated: resume.pdf is older than your Word edits. */
export const RESUME_STATES = ['generated', 'edited', 'edited_pdf_outdated'] as const;
export type PacketFile = keyof typeof PACKET_FILES;
const FILL_SHEET_MD = 'fill_sheet.md';
const FILL_SHEET_JSON = 'fill_sheet.json';
/** A fill_sheet.json bigger than this isn't read (the real ones are tens of KB). */
const FILL_SHEET_MAX_BYTES = 1024 * 1024;

export class QueueError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export type Application = {
  /** Position in `items`. */
  index: number;
  id: string;
  company: string;
  title: string;
  /** As written; `statusKnown` false means it isn't draft/reviewed/submitted (shown and flagged). */
  status: string;
  statusKnown: boolean;
  /** Career HQ's fit check tag (strong | reach | long_shot), as written; `fitKnown` false flags anything else. */
  fit: string | null;
  fitKnown: boolean;
  /** What happened after submitting (no_response | rejected | interview | offer), as written; null means pending. */
  outcome: string | null;
  outcomeKnown: boolean;
  /** When the outcome was recorded (YYYY-MM-DD). */
  outcomeOn: string | null;
  location: string | null;
  /** Only http/https links. */
  url: string | null;
  added: string | null;
  deadline: string | null;
  submittedOn: string | null;
  packet: string | null;
  notes: string | null;
  /** State of cover_letter.docx as the queue reports it (generated | edited | synced), as written; null when not set. */
  letter: string | null;
  /** State of resume.docx as the queue reports it (generated | edited | edited_pdf_outdated), as written; null when not set. */
  resume: string | null;
  /** Which packet files exist (only inside the repo; see packetDir). */
  files: { resume: boolean; resumeDocx: boolean; coverLetter: boolean; coverLetterDocx: boolean; fillSheet: boolean };
  /** Missing required fields and the like, shown on the card. */
  problems: string[];
  /** Fields over their limit and pending shorter drafts in its fill sheet (added by withLimits; null if unread). */
  limits?: LimitFlags | null;
};

export type Queue = {
  file: string;
  /** sha256 of the file's bytes; a status change must name the version the page loaded. */
  version: string;
  items: Application[];
  counts: Record<AppStatus, number>;
  /** Items that couldn't be read at all (no id), by position. */
  problems: string[];
};

export const versionOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
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

const mtime = (f: string) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * The queue files in the project's repos, then folders. Within one folder,
 * when both places hold a queue, the newer file comes first (the page warns
 * about the other). The first one is the one shown.
 */
export function findQueueFiles(p: { repos: string[]; folders: string[] }): string[] {
  return [...new Set([...p.repos, ...p.folders])].flatMap((d) =>
    QUEUE_FILES.map((q) => path.join(d, q))
      .filter((f) => fs.existsSync(f))
      .sort((a, b) => mtime(b) - mtime(a)),
  );
}

/** Every path a queue could be at in these folders (watched even before it exists). */
export const queueCandidates = (dirs: string[]) => dirs.flatMap((d) => QUEUE_FILES.map((q) => path.join(d, q)));

/** The folder the queue's paths are relative to: the repo holding jobs/. */
export function queueRoot(file: string) {
  const norm = file.split(path.sep).join('/');
  const q = QUEUE_FILES.find((name) => norm.endsWith(`/${name}`));
  return q ? file.slice(0, file.length - q.length - 1) : path.resolve(path.dirname(file), '..');
}

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

/** A packet file (resume.pdf, cover_letter.pdf, a fill sheet) inside the repo, or null. */
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
    const outcome = str(it.outcome);
    const outcomeKnown = !outcome || (OUTCOMES as readonly string[]).includes(outcome);
    if (!outcomeKnown) issues.push(`unknown outcome "${outcome}"`);
    if (outcome && status !== 'submitted') issues.push(`has an outcome but isn't submitted`);
    if (str(it.url) && !httpUrl(str(it.url))) issues.push('url is not an http(s) link');
    const letter = str(it.letter);
    if (letter && !(LETTER_STATES as readonly string[]).includes(letter)) issues.push(`unknown letter state "${letter}"`);
    const resume = str(it.resume);
    if (resume && !(RESUME_STATES as readonly string[]).includes(resume)) issues.push(`unknown resume state "${resume}"`);
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
      outcome,
      outcomeKnown,
      outcomeOn: str(it.outcome_on),
      location: str(it.location),
      url: httpUrl(str(it.url)),
      added: str(it.added),
      deadline: str(it.deadline),
      submittedOn: str(it.submitted_on),
      packet,
      notes: str(it.notes),
      letter,
      resume,
      files: {
        resume: !!packetFile(root, packet, PACKET_FILES.resume),
        resumeDocx: !!packetFile(root, packet, RESUME_DOCX),
        coverLetter: !!packetFile(root, packet, PACKET_FILES['cover-letter']),
        coverLetterDocx: !!packetFile(root, packet, LETTER_DOCX),
        fillSheet: !!(packetFile(root, packet, FILL_SHEET_JSON) || packetFile(root, packet, FILL_SHEET_MD)),
      },
      problems: issues,
    });
  });
  const counts = { draft: 0, reviewed: 0, submitted: 0 };
  for (const i of items) if (i.statusKnown) counts[i.status as AppStatus]++;
  return { file, version: versionOf(text), items, counts, problems };
}

export const readQueue = (file: string) => parseQueue(fs.readFileSync(file, 'utf8'), file);

// Fill sheets: one list of parts in display order, from fill_sheet.json when
// the packet has it (SPEC.md "Fill sheet JSON") or else fill_sheet.md
// (headings, **Label** lines each followed by the value in its own fenced code
// block, > notes and plain text). Notes never get a Copy button; neither does a
// missing value.
export type FieldCount = {
  /** The value's length in characters (Unicode code points, as Career HQ counts). */
  length: number;
  /** The length Career HQ wrote (`chars`); differs from `length` only if the file is stale. */
  chars: number | null;
  /** The form's limit (`max_chars`), only when Career HQ knows it (no limit given means "unknown"). */
  max: number | null;
  /** Over the limit: the hub's count is past `max`, or Career HQ says so (`over_limit`). */
  over: boolean;
  /** Career HQ's `over_limit` and the hub's own count disagree (the file may be stale). */
  overStale: boolean;
};

/** A shorter version Career HQ drafted for an over-limit field. Not approved: shown as a suggestion, never copied. */
export type ShorterDraft = {
  /** Exactly as Career HQ wrote it; the page hashes this string for approve-draft. */
  value: string;
  count: FieldCount;
  status: string;
  /** The answers.yaml question number approve-draft takes (JSON only; null means it can't be approved from the hub). */
  question: number | null;
};

export function fieldCount(value: string, chars: number | null, max: number | null, fileSaysOver: boolean | null): FieldCount {
  const length = charCount(value);
  const countedOver = max !== null && length > max;
  return { length, chars, max, over: countedOver || fileSaysOver === true, overStale: max !== null && fileSaysOver !== null && fileSaysOver !== countedOver };
}

export type FillPart =
  | { type: 'heading'; level: number; text: string }
  | { type: 'field'; label: string; hint: string | null; value: string; missing: boolean; count?: FieldCount; draft?: ShorterDraft }
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
  return { title, parts: mdLimits(parts) };
}

const DRAFT_LABEL = 'Shorter draft, pending your approval';

/**
 * fill_sheet.md writes limits as "(N / M characters max)" after a label,
 * "(N characters)" for a counted field, an "**OVER THE LIMIT**" note, and a
 * separate "Shorter draft, pending your approval" field. Turns those into the
 * same counts and drafts the JSON gives, so the page shows them the same way.
 */
function mdLimits(parts: FillPart[]): FillPart[] {
  const out: FillPart[] = [];
  let last: Extract<FillPart, { type: 'field' }> | null = null;
  for (const part of parts) {
    if (part.type === 'note' && last?.count && /^\*\*OVER THE LIMIT\*\*/.test(part.text)) {
      last.count = fieldCount(last.value, last.count.chars, last.count.max, true);
      continue;
    }
    if (part.type === 'note' && last?.count?.max != null && /^No shorter version drafted yet/.test(part.text)) continue;
    if (part.type !== 'field') {
      if (part.type === 'heading') last = null;
      out.push(part);
      continue;
    }
    const limit = part.hint?.match(/^\((\d+) \/ (\d+) characters max\)\s*(.*)$/);
    const counted = part.hint?.match(/^\((\d+) characters\)$/);
    if (part.label === DRAFT_LABEL && last?.count?.max != null) {
      const stillOver = /still over the limit/.test(limit?.[3] ?? '');
      last.draft = { value: part.value, count: fieldCount(part.value, limit ? Number(limit[1]) : null, last.count.max, stillOver || null), status: 'pending approval', question: null };
      continue;
    }
    if (limit && !part.missing) {
      part.count = fieldCount(part.value, Number(limit[1]), Number(limit[2]), null);
      part.hint = limit[3].trim() || null;
    } else if (counted && !part.missing) {
      part.count = fieldCount(part.value, Number(counted[1]), null, null);
      part.hint = null;
    }
    out.push(part);
    last = part;
  }
  return out;
}

// fill_sheet.json, version 1. Unknown keys are ignored; an unknown `version`
// is still read (and warned about), as SPEC.md asks.
const FILL_SHEET_FORMAT = 'career-hq fill sheet';
const KNOWN_VERSION = 1;
const count = z.number().int().nonnegative();
const fillSheetJsonSchema = z.object({
  format: z.literal(FILL_SHEET_FORMAT),
  version: z.number(),
  id: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  generated: z.string().optional(),
  missing_marker: z.string().default('[not in profile]'),
  sections: z.array(
    z.object({
      heading: z.string(),
      notes: z.array(z.object({ text: z.string(), group: z.string().nullish() })).default([]),
      fields: z
        .array(
          z.object({
            label: z.string(),
            value: z.string(),
            group: z.string().nullish(),
            chars: count.nullish(),
            max_chars: z.number().int().positive().nullish(),
            over_limit: z.boolean().nullish(),
            shorter_draft: z
              .object({ question: z.number().int().positive().nullish(), value: z.string(), chars: count.nullish(), status: z.string().nullish(), over_limit: z.boolean().nullish() })
              .nullish(),
          }),
        )
        .default([]),
    }),
  ),
});
export type FillSheetJson = z.infer<typeof fillSheetJsonSchema>;

export const charCount = (s: string) => [...s].length;

/**
 * Parses fill_sheet.json into parts: each section's heading, its section-wide
 * notes, then its fields, with a sub-heading where the `group` changes and that
 * group's notes under it. Notes for a group with no fields come last, under
 * their group's name.
 */
export function parseFillSheetJson(text: string): { sheet: FillSheetJson; parts: FillPart[]; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new QueueError(400, `${FILL_SHEET_JSON} is not valid JSON (${e instanceof Error ? e.message : e})`);
  }
  const parsed = fillSheetJsonSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new QueueError(400, `${FILL_SHEET_JSON} doesn't match the format: ${issue.path.join('.') || 'top level'}: ${issue.message}`);
  }
  const sheet = parsed.data;
  const warnings: string[] = [];
  if (sheet.version !== KNOWN_VERSION) warnings.push(`${FILL_SHEET_JSON} is version ${sheet.version}; this hub knows version ${KNOWN_VERSION}, so something may be missing or shown wrong.`);
  const parts: FillPart[] = [];
  for (const section of sheet.sections) {
    parts.push({ type: 'heading', level: 2, text: section.heading });
    const notesFor = (group: string | null) => section.notes.filter((n) => (n.group ?? null) === group).map((n): FillPart => ({ type: 'note', text: n.text }));
    parts.push(...notesFor(null));
    const shown = new Set<string>();
    let current: string | null = null;
    for (const f of section.fields) {
      const group = f.group ?? null;
      if (group !== current) {
        current = group;
        if (group !== null) {
          parts.push({ type: 'heading', level: 3, text: group });
          if (!shown.has(group)) parts.push(...notesFor(group));
          shown.add(group);
        }
      }
      const missing = f.value === sheet.missing_marker;
      const field: FillPart = { type: 'field', label: f.label, hint: null, value: f.value, missing };
      if (!missing && (f.chars != null || f.max_chars != null || f.over_limit != null)) field.count = fieldCount(f.value, f.chars ?? null, f.max_chars ?? null, f.over_limit ?? (f.max_chars != null ? false : null));
      if (f.shorter_draft) {
        const d = f.shorter_draft;
        field.draft = { value: d.value, count: fieldCount(d.value, d.chars ?? null, f.max_chars ?? null, d.over_limit ?? (f.max_chars != null ? false : null)), status: d.status ?? 'pending approval', question: d.question ?? null };
      }
      parts.push(field);
    }
    for (const group of new Set(section.notes.map((n) => n.group ?? null))) {
      if (group === null || shown.has(group)) continue;
      parts.push({ type: 'heading', level: 3, text: group }, ...notesFor(group));
    }
  }
  return { sheet, parts, warnings };
}

export type FillSheet = {
  id: string;
  company: string;
  role: string;
  sheetTitle: string | null;
  /** Which file the parts came from. */
  source: 'json' | 'md';
  /** When Career HQ generated it (JSON only). */
  generated: string | null;
  /** Shown above the sheet: an unknown version, an id that doesn't match, or why the JSON couldn't be used. */
  warnings: string[];
  parts: FillPart[];
};

/**
 * A queue item's fill sheet, read from inside the repo only: fill_sheet.json
 * when the packet has one that reads, else fill_sheet.md (with a warning if the
 * JSON was there but couldn't be used).
 */
export function readFillSheet(file: string, id: string): FillSheet {
  const q = readQueue(file);
  const item = q.items.find((i) => i.id === id);
  if (!item) throw new QueueError(404, `"${id}" isn't in the review queue`);
  return fillSheetFor(queueRoot(file), item);
}

export function fillSheetFor(root: string, item: Application): FillSheet {
  const id = item.id;
  const base = { id, company: item.company, role: item.title };
  let jsonProblem: string | null = null;
  const jsonFile = packetFile(root, item.packet, FILL_SHEET_JSON);
  if (jsonFile) {
    try {
      if (fs.statSync(jsonFile).size > FILL_SHEET_MAX_BYTES) throw new QueueError(400, `${FILL_SHEET_JSON} is over ${FILL_SHEET_MAX_BYTES / 1024 / 1024} MB`);
      const { sheet, parts, warnings: w } = parseFillSheetJson(fs.readFileSync(jsonFile, 'utf8'));
      if (sheet.id !== undefined && sheet.id !== id) w.push(`${FILL_SHEET_JSON} says it is for "${sheet.id}", not "${id}". Check you have the right packet.`);
      return { ...base, sheetTitle: null, source: 'json', generated: sheet.generated ?? null, warnings: w, parts };
    } catch (e) {
      if (!(e instanceof QueueError)) throw e;
      jsonProblem = e.message;
    }
  }
  const mdFile = packetFile(root, item.packet, FILL_SHEET_MD);
  if (!mdFile) {
    throw new QueueError(jsonProblem ? 400 : 404, jsonProblem ? `${jsonProblem}, and there is no ${FILL_SHEET_MD} to fall back on.` : `No fill sheet in ${item.packet ?? 'its packet'}`);
  }
  const md = parseFillSheet(fs.readFileSync(mdFile, 'utf8'));
  const warnings = jsonProblem ? [`${jsonProblem}, so this is ${FILL_SHEET_MD} instead.`] : [];
  return { ...base, sheetTitle: md.title, source: 'md', generated: null, warnings, parts: md.parts };
}

/** Adds each item's over-limit and pending-draft counts, for the warning on its card. */
export function withLimits<Q extends Queue>(q: Q): Q {
  const root = queueRoot(q.file);
  for (const item of q.items) {
    try {
      item.limits = item.files.fillSheet ? limitFlags(fillSheetFor(root, item).parts) : null;
    } catch {
      item.limits = null;
    }
  }
  return q;
}

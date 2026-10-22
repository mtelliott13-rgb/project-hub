// A project's checklist: toolkit.yaml at the top level of one of its repos or
// folders. The file is the source of truth; the hub only reads it and changes
// one item's `status`, by replacing exactly that value's characters in the
// text, so every other byte (comments, order, quoting, other fields) stays.
//
//   items:
//     - name: Bloomberg Market Concepts
//       category: Finance
//       url: https://portal.bloombergforeducation.com/
//       cost: $149
//       why: Fluency with the terminal most finance teams use
//       target: 2026-11-15      # optional, YYYY-MM-DD
//       status: in progress     # not started | in progress | done | parked
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, isSeq, parse, parseDocument, Scalar, type YAMLMap } from 'yaml';

export const TOOLKIT_FILE = 'toolkit.yaml';
export const STATUSES = ['not started', 'in progress', 'done', 'parked'] as const;
export type ToolkitStatus = (typeof STATUSES)[number];

export type ToolkitItem = {
  /** Position in `items`, which is how a write names it (with its name, to be sure). */
  index: number;
  name: string;
  category: string;
  /** Only http/https links; anything else is null (shown as `urlText`). */
  url: string | null;
  urlText: string | null;
  cost: string | null;
  why: string | null;
  target: string | null;
  status: ToolkitStatus;
  /** The value in the file when it isn't one of STATUSES (it then counts as not done). */
  unknownStatus: string | null;
};

export type Toolkit = {
  file: string;
  /** sha256 of the file's bytes, so a write can tell whether the file changed since it was read. */
  version: string;
  items: ToolkitItem[];
  done: number;
  /** Items that count: everything except parked. */
  total: number;
  /** Items that couldn't be read (e.g. no name), by position. */
  problems: string[];
};

export class ToolkitError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export const versionOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** toolkit.yaml files at the top level of the project's repos, then folders. */
export function findToolkitFiles(p: { repos: string[]; folders: string[] }): string[] {
  return [...new Set([...p.repos, ...p.folders])].map((d) => path.join(d, TOOLKIT_FILE)).filter((f) => fs.existsSync(f));
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? null : String(v));
const httpUrl = (v: string | null) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/** Reads the checklist from the file's text. Throws ToolkitError(400) if it isn't a toolkit. */
export function parseToolkit(text: string, file: string): Toolkit {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new ToolkitError(400, `${file} is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  const list = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) throw new ToolkitError(400, `${file} needs a top-level \`items:\` list`);
  const items: ToolkitItem[] = [];
  const problems: string[] = [];
  list.forEach((raw, index) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const name = str(it.name);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !name) {
      problems.push(`Item ${index + 1} has no name, so it's skipped`);
      return;
    }
    const s = str(it.status)?.trim().toLowerCase() ?? 'not started';
    const known = (STATUSES as readonly string[]).includes(s);
    items.push({
      index,
      name,
      category: str(it.category) ?? 'Other',
      url: httpUrl(str(it.url)),
      urlText: str(it.url),
      cost: str(it.cost),
      why: str(it.why),
      target: str(it.target), // shown as written; the page flags YYYY-MM-DD dates that have passed
      status: known ? (s as ToolkitStatus) : 'not started',
      unknownStatus: known ? null : str(it.status),
    });
  });
  const counted = items.filter((i) => i.status !== 'parked');
  return {
    file,
    version: versionOf(text),
    items,
    done: counted.filter((i) => i.status === 'done').length,
    total: counted.length,
    problems,
  };
}

export function readToolkit(file: string): Toolkit {
  return parseToolkit(fs.readFileSync(file, 'utf8'), file);
}

/** How a status value is written, matching the quoting the file already used for it. */
function scalarText(value: string, type: Scalar['type'] | undefined) {
  if (type === Scalar.QUOTE_DOUBLE) return JSON.stringify(value);
  if (type === Scalar.QUOTE_SINGLE) return `'${value}'`;
  return value; // all four statuses are safe as plain YAML
}

/**
 * Returns the text with item `index`'s status set to `status`, changing only
 * the characters of that value (or adding one `status:` line if it had none).
 * Refuses if the item at `index` isn't called `name`, then parses the result
 * and checks that nothing but that one status changed.
 */
export function setToolkitStatus(text: string, index: number, name: string, status: ToolkitStatus): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ToolkitError(400, `toolkit.yaml is not valid YAML: ${doc.errors[0].message}`);
  const seq = doc.get('items', true);
  if (!isSeq(seq)) throw new ToolkitError(400, 'toolkit.yaml needs a top-level `items:` list');
  const item = seq.items[index];
  if (!isMap(item) || str(item.get('name')) !== name) {
    throw new ToolkitError(409, `Item ${index + 1} is no longer "${name}"; the file has changed`);
  }
  let out: string;
  const node = (item as YAMLMap).get('status', true);
  if (node !== undefined && node !== null) {
    if (!isScalar(node) || !node.range) throw new ToolkitError(400, `"${name}" has a status that isn't a plain value`);
    const [start, end] = node.range;
    out = text.slice(0, start) + scalarText(status, node.type) + text.slice(end);
  } else {
    if (item.flow || !item.range) throw new ToolkitError(400, `"${name}" is written on one line ({…}); add its status line by hand`);
    const firstKey = item.items[0]?.key;
    const keyStart = isScalar(firstKey) && firstKey.range ? firstKey.range[0] : item.range[0];
    const indent = keyStart - (text.lastIndexOf('\n', keyStart - 1) + 1);
    // Right after the item's last character (blank lines between items stay
    // between items; a comment ending its last line stays on that line).
    let at = item.range[1];
    while (at > item.range[0] && /\s/.test(text[at - 1])) at--;
    out = `${text.slice(0, at)}\n${' '.repeat(indent)}status: ${status}${text.slice(at)}`;
  }

  // Check: the result parses, that item now has the new status, and nothing else differs.
  const before = parse(text) as { items: Record<string, unknown>[] };
  let after: { items: Record<string, unknown>[] };
  try {
    after = parse(out);
  } catch {
    throw new ToolkitError(400, 'Refusing to save: the edited file would not parse');
  }
  const expected = structuredClone(before);
  expected.items[index] = { ...expected.items[index], status };
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new ToolkitError(400, 'Refusing to save: the edit would change more than this item\'s status');
  }
  return out;
}

/**
 * Writes a status if the file is still the version the page loaded. The
 * first write to each file (per hub run) backs it up first. Writes via a
 * temp file and rename, keeping the file's permissions.
 */
export function writeToolkitStatus(opts: {
  file: string;
  version: string;
  index: number;
  name: string;
  status: ToolkitStatus;
  backupDir: string;
  backedUp: Set<string>;
  now?: Date;
}): Toolkit {
  const text = fs.readFileSync(opts.file, 'utf8');
  if (versionOf(text) !== opts.version) {
    throw new ToolkitError(409, 'toolkit.yaml was changed outside the hub since this page loaded it, so your change was not saved. This is the current version.');
  }
  const out = setToolkitStatus(text, opts.index, opts.name, opts.status);
  if (!opts.backedUp.has(opts.file)) {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const name = `${path.basename(path.dirname(opts.file))}.toolkit.${stamp}.yaml`;
    fs.writeFileSync(path.join(opts.backupDir, name), text, { flag: 'wx' });
    opts.backedUp.add(opts.file);
  }
  const mode = fs.statSync(opts.file).mode & 0o777;
  const tmp = `${opts.file}.project-hub-tmp`;
  fs.writeFileSync(tmp, out, { mode });
  fs.renameSync(tmp, opts.file);
  return parseToolkit(out, opts.file);
}

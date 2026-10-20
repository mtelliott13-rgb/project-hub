// Per-project text the hub keeps (SPEC.md, Phase 4), as plain Markdown files:
//   <root>/<slug>/notes.md                 notes, saved as you type
//   <root>/<slug>/monetize/<stamp>.md      one file per Generate, newest first
// Callers pass a slug the database already knows, so it is safe in a path.
import fs from 'node:fs';
import path from 'node:path';

export type DraftMeta = { id: string; generatedAt: string; costUsd: number | null; editedAt: string | null };
export type Draft = DraftMeta & { text: string };

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?Z$/;

/** Writes via a temp file so a crash never leaves half a file. */
function writeFile(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const mtime = (file: string) => fs.statSync(file).mtime.toISOString();

// A draft file is a little front matter, then the draft exactly as shown on the page.
function parseDraft(id: string, raw: string): Draft {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  const head: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const cost = Number(head.cost_usd);
  return {
    id,
    generatedAt: head.generated ?? id,
    costUsd: Number.isFinite(cost) ? cost : null,
    editedAt: head.edited ?? null,
    text: m ? m[2] : raw,
  };
}

function formatDraft(d: Omit<Draft, 'id'>): string {
  const head = [`generated: ${d.generatedAt}`];
  if (d.costUsd !== null) head.push(`cost_usd: ${d.costUsd}`);
  if (d.editedAt) head.push(`edited: ${d.editedAt}`);
  return `---\n${head.join('\n')}\n---\n\n${d.text}`;
}

export function projectDocs(root: string) {
  const dir = (slug: string) => path.join(root, slug);
  const notesFile = (slug: string) => path.join(dir(slug), 'notes.md');
  const draftsDir = (slug: string) => path.join(dir(slug), 'monetize');
  const draftFile = (slug: string, id: string) => {
    if (!STAMP.test(id)) throw new Error(`Bad draft id ${id}`);
    return path.join(draftsDir(slug), `${id}.md`);
  };
  const draft = (slug: string, id: string): Draft | null => {
    const f = draftFile(slug, id);
    return fs.existsSync(f) ? parseDraft(id, fs.readFileSync(f, 'utf8')) : null;
  };

  return {
    dir,

    notes(slug: string): { text: string; savedAt: string | null } {
      const f = notesFile(slug);
      return fs.existsSync(f) ? { text: fs.readFileSync(f, 'utf8'), savedAt: mtime(f) } : { text: '', savedAt: null };
    },

    saveNotes(slug: string, text: string) {
      writeFile(notesFile(slug), text);
      return { savedAt: mtime(notesFile(slug)) };
    },

    /** Every draft, newest first, without its text. */
    drafts(slug: string): DraftMeta[] {
      const d = draftsDir(slug);
      if (!fs.existsSync(d)) return [];
      return fs
        .readdirSync(d)
        .filter((f) => f.endsWith('.md') && STAMP.test(f.slice(0, -3)))
        .sort()
        .reverse()
        .map((f) => {
          const { text: _text, ...meta } = parseDraft(f.slice(0, -3), fs.readFileSync(path.join(d, f), 'utf8'));
          return meta;
        });
    },

    draft,

    /** Saves a new draft from Generate. Returns its id. */
    addDraft(slug: string, text: string, costUsd: number | null, now = new Date()): string {
      const id = now.toISOString().replace(/[:.]/g, '-');
      writeFile(draftFile(slug, id), formatDraft({ generatedAt: now.toISOString(), costUsd, editedAt: null, text }));
      return id;
    },

    /** Saves your edits to one draft, keeping when it was generated. */
    editDraft(slug: string, id: string, text: string, now = new Date()) {
      const d = draft(slug, id);
      if (!d) throw new Error(`No draft ${id}`);
      writeFile(draftFile(slug, id), formatDraft({ ...d, text, editedAt: now.toISOString() }));
      return { savedAt: now.toISOString() };
    },
  };
}

export type ProjectDocs = ReturnType<typeof projectDocs>;

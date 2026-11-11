// Are a packet's resume.pdf and cover_letter.pdf current? Career HQ decides,
// with the same check /apply runs right before each upload:
//   uv run python scripts/fill_plan.py files <id>
// It prints {"id", "files": {"resume"?, "cover_letter"?}, "notes"} listing
// only PDFs made from their .docx exactly as it is now (SHA-256 fingerprints,
// never file dates; SPEC.md "Editing the resume in Word"). It only reads.
//
// The hub never judges currency itself. File sizes, times and inodes only
// decide when to ask Career HQ again (a cache), never the answer. Read only,
// so it doesn't take the Career HQ button lock; at most two checks run at
// once, and requests for a packet already being checked share that run.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LETTER_DOCX, PACKET_FILES, packetDir, packetFile, RESUME_DOCX, type Application } from './applications.ts';

export const FILES_SCRIPT = 'scripts/fill_plan.py';
const CHECK_TIMEOUT_MS = 30_000;
/** Ask again after this long even if no file looks changed. */
const TTL_MS = 5 * 60_000;

/** One document's PDF: current, not made from the .docx as it is now (Career HQ's note), or not built. */
export type DocCheck = { state: 'current' | 'outdated' | 'no-pdf'; note: string | null };
/** null for a document whose .docx the packet doesn't have (nothing in Word to be out of date with). */
export type PdfCheck = { checked: string; resume: DocCheck | null; letter: DocCheck | null } | { error: string };

const filesOutput = z.object({
  id: z.string(),
  files: z.object({ resume: z.string().optional(), cover_letter: z.string().optional() }),
  notes: z.array(z.string()),
});

/** What the check needs to run a Career HQ command (queue-status.ts supplies its runner). */
export type CheckRunner = (argv: string[], cwd: string, timeoutMs: number) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

export type PdfChecker = (root: string, item: Pick<Application, 'id' | 'packet'>, opts?: { fresh?: boolean }) => Promise<PdfCheck>;

/** The files whose change means Career HQ's answer may have changed. */
function statKey(root: string, packet: string | null): string {
  const dir = packetDir(root, packet);
  const names = [RESUME_DOCX, PACKET_FILES.resume, 'resume_state.json', 'resume.yaml', LETTER_DOCX, PACKET_FILES['cover-letter'], 'letter_state.json', 'cover_letter.yaml'];
  // An older letter with no record is compared against the master profile's contact lines.
  const paths = [...(dir ? names.map((n) => path.join(dir, n)) : []), path.join(root, 'resume/master_profile.yaml')];
  return paths
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

/** Career HQ's answer, read against the packet: a path counts only if it is exactly that packet's PDF. */
export function interpret(root: string, item: Pick<Application, 'id' | 'packet'>, stdout: string): PdfCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { error: "Career HQ's check didn't print JSON" };
  }
  const parsed = filesOutput.safeParse(raw);
  if (!parsed.success) return { error: "Career HQ's check printed something other than its files format" };
  if (parsed.data.id !== item.id) return { error: `Career HQ's check answered for "${parsed.data.id}", not ${item.id}` };
  const doc = (docx: string, pdfName: string, listed: string | undefined): DocCheck | null => {
    if (!packetFile(root, item.packet, docx)) return null;
    const pdf = packetFile(root, item.packet, pdfName);
    if (!pdf) return { state: 'no-pdf', note: null };
    let current = false;
    try {
      current = !!listed && fs.realpathSync(listed) === pdf;
    } catch {
      current = false;
    }
    return current ? { state: 'current', note: null } : { state: 'outdated', note: parsed.data.notes.find((n) => n.startsWith(pdfName)) ?? null };
  };
  return {
    checked: new Date().toISOString(),
    resume: doc(RESUME_DOCX, PACKET_FILES.resume, parsed.data.files.resume),
    letter: doc(LETTER_DOCX, PACKET_FILES['cover-letter'], parsed.data.files.cover_letter),
  };
}

export function createPdfChecker(opts: { uvPath: string; run: CheckRunner; timeoutMs?: number; maxRuns?: number; ttlMs?: number }): PdfChecker {
  const cache = new Map<string, { key: string; at: number; result: PdfCheck }>();
  const inFlight = new Map<string, Promise<PdfCheck>>();
  const waiting: (() => void)[] = [];
  let running = 0;
  const maxRuns = opts.maxRuns ?? 2;
  const slot = async () => {
    if (running >= maxRuns) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  const runCheck = async (root: string, item: Pick<Application, 'id' | 'packet'>): Promise<PdfCheck> => {
    const script = path.join(root, FILES_SCRIPT);
    try {
      const real = fs.realpathSync(script);
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error();
    } catch {
      return { error: `No ${FILES_SCRIPT} inside the repo` };
    }
    await slot();
    try {
      const run = await opts.run([opts.uvPath, 'run', 'python', FILES_SCRIPT, 'files', item.id], root, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
      return run.ok ? interpret(root, item, run.stdout) : { error: run.error };
    } finally {
      release();
    }
  };

  return (root, item, { fresh = false } = {}) => {
    const id = `${root}\0${item.id}`;
    const key = statKey(root, item.packet);
    const hit = cache.get(id);
    if (!fresh && hit && hit.key === key && Date.now() - hit.at < (opts.ttlMs ?? TTL_MS)) return Promise.resolve(hit.result);
    // A fresh check (Rebuild PDF) never joins one that started before it.
    const pending = inFlight.get(id);
    if (pending && !fresh) return pending;
    const p = runCheck(root, item)
      .then((result) => {
        // Errors aren't kept, so the next look asks again.
        if ('error' in result) cache.delete(id);
        // Keyed by the files as they were before it ran: one changed meanwhile means asking again.
        else cache.set(id, { key, at: Date.now(), result });
        return result;
      })
      .finally(() => {
        if (inFlight.get(id) === p) inFlight.delete(id);
      });
    inFlight.set(id, p);
    return p;
  };
}

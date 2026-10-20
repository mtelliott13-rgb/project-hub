// The Ideas list (SPEC.md, Phase 4): ~/.project-hub/ideas.md, a Markdown
// checklist that the hub page edits and Claude Code reads (CLAUDE.md points
// here). One item per line:
//   - [ ] Cmd-K project switcher · hub · added 2026-10-20
//   - [x] Archive projects · hub · added 2026-10-20 · done 2026-10-20
// The scope is `hub` or a project slug. Lines that aren't items are kept as is.

export const IDEAS_HEADER = `# Ideas

Features wanted for the Project Hub or one of its projects, typed on the hub's
Ideas page (http://127.0.0.1:4747/ideas). When asked "what's next", treat the
open items as the to-do list, top first. When one is built, mark it done here:
change \`[ ]\` to \`[x]\` and add \` · done YYYY-MM-DD\` at the end of the line.

`;

export type Idea = {
  /** The item's line number in the file (0-based); stable until the file changes. */
  line: number;
  text: string;
  scope: string;
  done: boolean;
  added: string | null;
  doneOn: string | null;
};

export class IdeasError extends Error {
  status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const ITEM = /^- \[([ xX])\] (.*)$/;
const SEP = ' · ';
const DATE = /^(added|done) (\d{4}-\d{2}-\d{2})$/;

function parseLine(raw: string, line: number): Idea | null {
  const m = raw.match(ITEM);
  if (!m) return null;
  const [text, ...rest] = m[2].split(SEP);
  const idea: Idea = { line, text: text.trim(), scope: 'hub', done: m[1] !== ' ', added: null, doneOn: null };
  for (const part of rest) {
    const d = part.trim().match(DATE);
    if (d?.[1] === 'added') idea.added = d[2];
    else if (d?.[1] === 'done') idea.doneOn = d[2];
    else if (part.trim()) idea.scope = part.trim();
  }
  return idea;
}

function formatLine(i: Omit<Idea, 'line'>): string {
  const parts = [i.text, i.scope];
  if (i.added) parts.push(`added ${i.added}`);
  if (i.done && i.doneOn) parts.push(`done ${i.doneOn}`);
  return `- [${i.done ? 'x' : ' '}] ${parts.join(SEP)}`;
}

/** Idea text is one line, and can't contain the field separator. */
export function cleanText(text: string): string {
  const t = text.replace(/\s+/g, ' ').split(SEP.trim()).join('-').trim();
  if (!t) throw new IdeasError(400, 'An idea needs some text');
  if (t.length > 500) throw new IdeasError(400, 'Keep an idea under 500 characters');
  return t;
}

export const parseIdeas = (text: string): Idea[] =>
  text.split('\n').flatMap((raw, i) => {
    const idea = parseLine(raw, i);
    return idea ? [idea] : [];
  });

const today = (now: Date) => now.toISOString().slice(0, 10);

/** Adds an open idea after the last item (or at the end of a new file). */
export function addIdea(text: string, idea: { text: string; scope: string }, now = new Date()): string {
  const lines = (text || IDEAS_HEADER).split('\n');
  const line = formatLine({ text: cleanText(idea.text), scope: idea.scope, done: false, added: today(now), doneOn: null });
  const last = parseIdeas(lines.join('\n')).at(-1);
  if (last) lines.splice(last.line + 1, 0, line);
  else {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push('', line, '');
  }
  return lines.join('\n');
}

/**
 * Changes one item. `expect` is the text the page showed, so an item that was
 * changed or moved in the file since then is refused rather than clobbered.
 */
export function editIdea(
  text: string,
  line: number,
  expect: string,
  change: { text?: string; scope?: string; done?: boolean } | 'delete',
  now = new Date(),
): string {
  const lines = text.split('\n');
  const current = lines[line] === undefined ? null : parseLine(lines[line], line);
  if (!current || current.text !== expect) {
    throw new IdeasError(409, 'ideas.md changed since the page loaded it. Reload and try again.');
  }
  if (change === 'delete') lines.splice(line, 1);
  else {
    const done = change.done ?? current.done;
    lines[line] = formatLine({
      text: change.text === undefined ? current.text : cleanText(change.text),
      scope: change.scope ?? current.scope,
      done,
      added: current.added,
      doneOn: done ? (current.done ? current.doneOn : today(now)) : null,
    });
  }
  return lines.join('\n');
}

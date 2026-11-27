// Which note lines look like they mention a date or time, by simple local rules
// (no network, no parser): weekday names, today/tomorrow/tonight, next week,
// month names with a day, numeric dates like 12/3, and times like 3pm or 14:30.
// Only when you click a suggestion is that one line sent to the quick-add
// parser. Tested in test/note-dates.test.ts.

const WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i;
// Short weekday names only when capitalised ("Fri") and used like a day: after on/by/next/every/this,
// or before a number, a comma or the end of the line. So "I sat on it" or "Sun glare" don't count.
const SHORT = '(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)';
const WEEKDAY_SHORT = new RegExp(`\\b(on|by|next|every|this)\\s+${SHORT}\\b|\\b${SHORT}\\.?(?=\\s+\\d|\\s*,|\\s*$)`);
const RELATIVE = /\b(today|tonight|tomorrow|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (weekend|week))\b/i;
const MONTH_DAY =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
// Full month names on their own ("in December") also count; short ones need a day.
const MONTH_FULL = /\b(january|february|april|june|july|august|september|october|november|december)\b/i;
// 12/3 or 12/3/2026, with a real month and day.
const NUMERIC = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(\/(\d{2}|\d{4}))?\b/;
const TIME = /\b((1[0-2]|0?[1-9])(:[0-5]\d)?\s?(am|pm|a\.m\.|p\.m\.))(?![a-z])|\b([01]?\d|2[0-3]):[0-5]\d\b/i;

const RULES = [WEEKDAY, WEEKDAY_SHORT, RELATIVE, MONTH_DAY, MONTH_FULL, NUMERIC, TIME];

/** Whether one line looks like it has a date or time in it. */
export function looksDated(line: string): boolean {
  // Links and code are usually not appointments ("…/2024/12/3", "10:30" in a log line).
  const text = line.replace(/https?:\/\/\S+/g, ' ').replace(/`[^`]*`/g, ' ');
  return RULES.some((re) => re.test(text));
}

export type DatedLine = { line: string; text: string };

/** Note lines worth an "Add to calendar?": dated, not done (- [x]), not inside code fences, each line once. */
export function datedLines(notes: string): DatedLine[] {
  const out: DatedLine[] = [];
  const seen = new Set<string>();
  let fenced = false;
  for (const raw of notes.split('\n')) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.trim();
    if (!line || line.length > 300 || /^[-*]\s+\[x\]/i.test(line)) continue;
    // Drop list markers and headings for what goes to the parser.
    const text = line.replace(/^(#{1,6}\s+|[-*+]\s+(\[ \]\s+)?|\d+[.)]\s+)/, '').trim();
    if (!text || seen.has(line) || !looksDated(text)) continue;
    seen.add(line);
    out.push({ line, text });
  }
  return out;
}

// Edits to projects.yaml from the hub page. Each edit changes only the
// project it names and keeps everything else (comments, order, layout) as it
// is, then parses the result back and checks it says exactly what was asked.
import os from 'node:os';
import path from 'node:path';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { z } from 'zod';
import { parseProjects, type ProjectConfig } from './projects.ts';

/** What the Add and Edit forms send. Paths are absolute. */
export const projectInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  repos: z.array(z.string().min(1)).default([]),
  folders: z.array(z.string().min(1)).default([]),
  github: z.array(z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'GitHub repos must be owner/repo')).default([]),
  claude_project: z
    .string()
    .trim()
    .regex(/^https:\/\/claude\.ai\/project\/[0-9a-f-]{36}\/?$/i, 'Claude Project links look like https://claude.ai/project/<id>')
    .nullable()
    .default(null),
  keywords: z.array(z.string().trim().min(1)).default([]),
});

export type ProjectInput = z.infer<typeof projectInputSchema>;

export class ProjectsFileError extends Error {}

const HOME = os.homedir();

/** Writes ~ for the home folder, as people do by hand. */
export const collapseHome = (p: string) =>
  p === HOME ? '~' : p.startsWith(HOME + path.sep) ? `~/${p.slice(HOME.length + 1)}` : p;

/** "Kratos Marketing!" -> "kratos-marketing", made unique against `taken`. */
export function slugFor(name: string, taken: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

function load(text: string) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ProjectsFileError(`projects.yaml is not valid YAML: ${doc.errors[0].message}`);
  parseProjects(text); // Refuse to edit a file that is already invalid.
  let seq = doc.get('projects') as YAMLSeq | undefined;
  if (seq == null) {
    seq = doc.createNode([]) as YAMLSeq;
    doc.set('projects', seq);
  }
  if (!isSeq(seq)) throw new ProjectsFileError('projects.yaml: `projects` must be a list');
  return { doc, seq };
}

const indexOf = (seq: YAMLSeq, slug: string) => seq.items.findIndex((m) => isMap(m) && m.get('slug') === slug);

const flow = (doc: Document, items: string[]) => {
  const node = doc.createNode(items) as YAMLSeq;
  node.flow = true;
  return node;
};

function setFields(doc: Document, map: YAMLMap, input: ProjectInput) {
  map.set('name', input.name);
  const lists = {
    repos: input.repos.map(collapseHome),
    folders: input.folders.map(collapseHome),
    github: input.github,
  };
  for (const [key, value] of Object.entries(lists)) {
    if (value.length) map.set(key, flow(doc, value));
    else map.delete(key);
  }
  if (input.claude_project) map.set('claude_project', input.claude_project);
  else map.delete('claude_project');
  if (input.keywords.length) map.set('keywords', flow(doc, input.keywords));
  else map.delete('keywords');
}

const toText = (doc: Document) => doc.toString({ lineWidth: 0, flowCollectionPadding: false });

/** Parses the new text and checks the project now reads back as intended. */
function verified(text: string, slug: string, expect: Partial<ProjectConfig> | null): string {
  const found = parseProjects(text).find((p) => p.slug === slug);
  if (expect === null) {
    if (found) throw new ProjectsFileError(`Refusing to save: ${slug} is still in the file`);
    return text;
  }
  if (!found) throw new ProjectsFileError(`Refusing to save: ${slug} did not read back`);
  for (const [k, v] of Object.entries(expect)) {
    const got = found[k as keyof ProjectConfig] ?? null;
    if (JSON.stringify(got) !== JSON.stringify(v ?? null)) {
      throw new ProjectsFileError(`Refusing to save: ${slug}.${k} reads back as ${JSON.stringify(got)}`);
    }
  }
  return text;
}

const expected = (input: ProjectInput): Partial<ProjectConfig> => ({
  name: input.name,
  repos: input.repos,
  folders: input.folders,
  github: input.github,
  claude_project: input.claude_project ?? undefined,
  keywords: input.keywords,
});

export function addProject(text: string, slug: string, input: ProjectInput): string {
  const { doc, seq } = load(text);
  if (indexOf(seq, slug) !== -1) throw new ProjectsFileError(`A project with slug ${slug} already exists`);
  const map = doc.createNode({ slug }) as YAMLMap;
  setFields(doc, map, input);
  if (seq.items.length) map.spaceBefore = true;
  seq.items.push(map);
  return verified(toText(doc), slug, expected(input));
}

export function updateProject(text: string, slug: string, input: ProjectInput): string {
  const { doc, seq } = load(text);
  const map = seq.items[indexOf(seq, slug)];
  if (!isMap(map)) throw new ProjectsFileError(`${slug} is not in projects.yaml`);
  setFields(doc, map, input);
  return verified(toText(doc), slug, expected(input));
}

/**
 * Archives or unarchives. A project missing from the file (removed by hand)
 * is written back from `fallback` when unarchived.
 */
export function setArchived(text: string, slug: string, archived: boolean, fallback?: ProjectConfig): string {
  const { doc, seq } = load(text);
  const existing = seq.items[indexOf(seq, slug)];
  let map: YAMLMap;
  if (isMap(existing)) map = existing;
  else {
    if (archived || !fallback) throw new ProjectsFileError(`${slug} is not in projects.yaml`);
    map = doc.createNode({ slug }) as YAMLMap;
    setFields(doc, map, { ...fallback, claude_project: fallback.claude_project ?? null });
    if (fallback.sessions.length) map.set('sessions', flow(doc, fallback.sessions));
    if (seq.items.length) map.spaceBefore = true;
    seq.items.push(map);
  }
  if (archived) map.set('archived', true);
  else map.delete('archived');
  return verified(toText(doc), slug, { archived });
}

/** Removes the project's entry. Leaves the file as is if it isn't listed. */
export function removeProject(text: string, slug: string): string {
  const { doc, seq } = load(text);
  const i = indexOf(seq, slug);
  if (i === -1) return text;
  const [removed] = seq.items.splice(i, 1);
  // Keep the blank line a following project had before the removed one.
  const next = seq.items[i];
  if (i === 0 && isMap(next)) next.spaceBefore = (removed as YAMLMap).spaceBefore;
  return verified(toText(doc), slug, null);
}

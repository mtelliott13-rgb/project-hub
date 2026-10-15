import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const expandHome = (p: string) =>
  p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;

const pathList = z.array(z.string().min(1)).default([]).transform((ps) => ps.map(expandHome));

const projectSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),
  name: z.string().min(1),
  repos: pathList,
  folders: pathList,
  github: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'github entries must be owner/repo'))
    .default([]),
  claude_project: z.url().optional(),
  keywords: z.array(z.string().min(1)).default([]),
});

const fileSchema = z.object({
  projects: z.array(projectSchema).default([]),
});

export type ProjectConfig = z.infer<typeof projectSchema>;

/** Parses projects.yaml text. Throws with a readable message on bad input. */
export function parseProjects(text: string): ProjectConfig[] {
  const result = fileSchema.safeParse(parse(text) ?? {});
  if (!result.success) {
    throw new Error(`projects.yaml is invalid:\n${z.prettifyError(result.error)}`);
  }
  const seen = new Set<string>();
  for (const p of result.data.projects) {
    if (seen.has(p.slug)) throw new Error(`projects.yaml is invalid: duplicate slug "${p.slug}"`);
    seen.add(p.slug);
  }
  return result.data.projects;
}

/** Reads projects.yaml; a missing file means no projects yet. */
export function loadProjects(file: string): ProjectConfig[] {
  if (!fs.existsSync(file)) return [];
  return parseProjects(fs.readFileSync(file, 'utf8'));
}

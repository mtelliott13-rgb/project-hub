// Recent files (SPEC.md, Phase 6): the newest changes in the project's repos and
// folders, live. Clicking one opens it in VS Code.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchFiles } from '../api.ts';
import { ago, shortenHome } from '../ui.tsx';
import type { SectionProps } from './sections.tsx';

export function FilesSection({ project, run }: SectionProps) {
  const { data, error } = useQuery({ queryKey: ['files', project.slug], queryFn: () => fetchFiles(project.slug) });
  const [showAll, setShowAll] = useState(false);
  if (project.repos.length + project.folders.length === 0) return <p className="text-sm text-stone-500">This project has no repos or folders. Add one with Edit.</p>;
  if (error) return <p className="text-sm text-red-600">{error.message}</p>;
  if (!data) return <p className="text-sm text-stone-500">Loading…</p>;
  const scanning = data.watching.some((w) => !w.ready);
  const several = new Set(data.files.map((f) => f.root)).size > 1;
  const shown = showAll ? data.files : data.files.slice(0, 10);
  return (
    <div className="space-y-2">
      {data.files.length === 0 && <p className="text-sm text-stone-500">{scanning ? 'Looking…' : 'No files yet.'}</p>}
      <ul className="text-sm" data-testid="recent-files">
        {shown.map((f) => (
          <li key={f.path} className="flex items-center gap-2 py-0.5" data-testid="recent-file">
            <button
              type="button"
              title={`Open ${shortenHome(f.path)} in VS Code`}
              onClick={() => run({ kind: 'file', slug: project.slug, path: f.path })}
              className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
            >
              {several && <span className="text-stone-500">{shortenHome(f.root).split('/').pop()}/</span>}
              {f.rel}
            </button>
            <span className="shrink-0 text-xs text-stone-500">{ago(f.mtime)}</span>
          </li>
        ))}
      </ul>
      {data.files.length > 10 && (
        <button type="button" className="text-xs text-stone-500 underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show ${data.files.length}`}
        </button>
      )}
      <p className="text-xs text-stone-500">
        Live. Skips .git, node_modules, build output and anything git ignores.
        {data.missing.length > 0 && ` Not found: ${data.missing.map(shortenHome).join(', ')}.`}
        {data.watching.filter((w) => w.error).map((w) => ` ${shortenHome(w.dir)}: ${w.error}`)}
      </p>
    </div>
  );
}

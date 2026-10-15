import { useQuery } from '@tanstack/react-query';
import type { Project } from '../../src/server/db/schema.ts';

// Dates arrive as ISO strings over JSON.
type ProjectDto = Omit<Project, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error(`GET /api/projects failed: ${res.status}`);
  return res.json();
}

const shortenHome = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

export function App() {
  const { data, error, isPending } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Project Hub</h1>
        {isPending && <p className="text-stone-500">Loading…</p>}
        {error && <p className="text-red-600">{error.message}</p>}
        {data?.length === 0 && (
          <p className="text-stone-500">No projects yet. Add some to ~/.project-hub/projects.yaml and restart the hub.</p>
        )}
        <ul className="grid gap-4 sm:grid-cols-2">
          {data?.map((p) => (
            <li
              key={p.slug}
              data-testid="project-card"
              className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
            >
              <h2 className="text-lg font-medium">{p.name}</h2>
              <p className="font-mono text-xs text-stone-500">{p.slug}</p>
              <dl className="mt-3 space-y-1 text-sm">
                {p.repos.length > 0 && <Row label="Repo" values={p.repos.map(shortenHome)} />}
                {p.folders.length > 0 && <Row label="Folders" values={p.folders.map(shortenHome)} />}
                {p.github.length > 0 && <Row label="GitHub" values={p.github} />}
                {p.keywords.length > 0 && <Row label="Keywords" values={p.keywords} />}
              </dl>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

function Row({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-stone-500">{label}</dt>
      <dd className="font-mono break-all">{values.join(', ')}</dd>
    </div>
  );
}

// A project's own page: everything about it, built from SECTIONS.
import { useQuery } from '@tanstack/react-query';
import { fetchProjects } from './api.ts';
import { ProjectActions, ProjectMenu, StatusBadge, type Run } from './project/parts.tsx';
import { SECTIONS, type Section } from './project/sections.tsx';
import { navigate } from './router.tsx';
import { shortenHome } from './ui.tsx';

export function ProjectPage({ slug, run }: { slug: string; run: Run }) {
  const { data, error, isPending } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const p = data?.find((x) => x.slug === slug);
  if (isPending) return <p className="text-stone-500">Loading…</p>;
  if (error) return <p className="text-red-600">{error.message}</p>;
  if (!p) return <p className="text-stone-500">There's no project called {slug}. It may have been deleted.</p>;

  const where = [...p.repos, ...p.folders].map(shortenHome);
  const column = (c: Section['column']) =>
    SECTIONS.filter((s) => s.column === c && (s.show?.(p) ?? true)).map((s) => (
      <section key={s.id} data-section={s.id} className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase">{s.title(p)}</h2>
        <s.Component project={p} run={run} />
      </section>
    ));

  return (
    <div className="space-y-5" data-testid="project-page">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{p.name}</h1>
            <p className="mt-1 font-mono text-xs break-all text-stone-500">
              {[...where, ...(p.github.length ? [`GitHub: ${p.github.join(', ')}`] : []), ...(p.keywords.length ? [`keywords: ${p.keywords.join(', ')}`] : [])].join(' · ')}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusBadge project={p} />
            <ProjectMenu project={p} onDeleted={() => navigate('/')} />
          </div>
        </div>
        <ProjectActions project={p} run={run} />
      </header>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">{column('main')}</div>
        <div className="space-y-5">{column('side')}</div>
      </div>
    </div>
  );
}

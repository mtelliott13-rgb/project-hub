// A project's own page (v4): breadcrumb, header card, charts row, then the
// sections from SECTIONS, each folding away and remembered per project.
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { fetchProjects } from './api.ts';
import { type Run } from './project/parts.tsx';
import { ChartsRow } from './project/ProjectCharts.tsx';
import { ProjectHeader } from './project/ProjectHeader.tsx';
import { SECTIONS, type Section } from './project/sections.tsx';
import { useActivity } from './project/status.tsx';
import { Link, navigate } from './router.tsx';
import { CollapsibleSection, setAllSections } from './ui.tsx';

export function ProjectPage({ slug, run }: { slug: string; run: Run }) {
  const { data, error, isPending } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const p = data?.find((x) => x.slug === slug);
  const activity = useActivity()?.[slug];
  if (isPending) return <p className="text-muted">Loading…</p>;
  if (error) return <p className="text-red-600">{error.message}</p>;
  if (!p) return <p className="text-muted">There's no project called {slug}. It may have been deleted.</p>;

  const column = (c: Section['column']) =>
    SECTIONS.filter((s) => s.column === c && (s.show?.(p) ?? true)).map((s) => (
      <CollapsibleSection key={`${p.slug}:${s.id}`} scope={p.slug} id={s.id} title={s.title(p)} summary={s.summary?.(p)} hint={s.hint} defaultOpen={s.defaultOpen ?? true} data-section={s.id}>
        <s.Component project={p} run={run} />
      </CollapsibleSection>
    ));

  return (
    <div className="space-y-5" data-testid="project-page">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-meta text-muted">
        <Link to="/" className="hover:text-ink hover:underline">
          Projects
        </Link>
        <ChevronRight size={13} aria-hidden />
        <span aria-current="page" className="truncate font-medium text-ink">
          {p.name}
        </span>
      </nav>
      <ProjectHeader project={p} run={run} activity={activity} onDeleted={() => navigate('/')} />
      <ChartsRow project={p} />
      <div className="flex justify-end gap-3 text-meta">
        <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => setAllSections(p.slug, true)}>
          Expand all
        </button>
        <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => setAllSections(p.slug, false)}>
          Collapse all
        </button>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-4">{column('main')}</div>
        <div className="min-w-0 space-y-4">{column('side')}</div>
      </div>
    </div>
  );
}

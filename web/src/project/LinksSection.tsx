// Docs and links filed into this project (SPEC.md, Phase 6), by hand, by a rule,
// or because they point at the project's GitHub repo or Claude Project.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteLink, fetchProjectLinks, fileLink } from '../api.ts';
import { AddLinkForm, linkLabel } from '../InboxPage.tsx';
import type { SectionProps } from './sections.tsx';

const how: Record<string, string> = { rule: 'by a rule', github: 'its GitHub repo', 'claude-project': 'its Claude Project', manual: 'by hand' };

export function LinksSection({ project }: SectionProps) {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['links', project.slug], queryFn: () => fetchProjectLinks(project.slug) });
  const [note, setNote] = useState<string | null>(null);
  const done = () => void queryClient.invalidateQueries();
  const unfile = useMutation({ mutationFn: (id: number) => fileLink(id, null), onSuccess: done });
  const remove = useMutation({ mutationFn: deleteLink, onSuccess: done });
  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-600">{error.message}</p>}
      {data?.length === 0 && <p className="text-sm text-stone-500">None yet.</p>}
      <ul className="text-sm" data-testid="project-links">
        {data?.map((l) => (
          <li key={l.id} className="group flex items-center gap-2 py-0.5">
            <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline" title={`${l.url}\nFiled ${how[l.filedBy ?? ''] ?? ''}`}>
              {linkLabel(l)}
            </a>
            <span className="flex shrink-0 gap-2 opacity-0 group-hover:opacity-100">
              <button type="button" className="text-xs text-stone-500 hover:underline" onClick={() => unfile.mutate(l.id)}>
                To Inbox
              </button>
              <button type="button" aria-label={`Delete link ${l.url}`} className="text-xs text-stone-400 hover:text-red-600" onClick={() => confirm(`Delete this link?\n\n${l.url}`) && remove.mutate(l.id)}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      <AddLinkForm slug={project.slug} onAdded={setNote} />
      {note && <p className="text-xs text-stone-500">{note}</p>}
    </div>
  );
}

// Notes for a project: plain text in ~/.project-hub/projects/<slug>/notes.md, saved as you type.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchNotes, saveNotes } from '../api.ts';
import { saveLabel, useAutosave } from '../autosave.ts';
import type { SectionProps } from './sections.tsx';

export function NotesSection({ project }: SectionProps) {
  return <Notes key={project.slug} slug={project.slug} />;
}

function Notes({ slug }: { slug: string }) {
  // Loaded once; after that the text box is the truth, so a refresh never overwrites typing.
  const loaded = useQuery({ queryKey: ['notes', slug], queryFn: () => fetchNotes(slug), staleTime: Infinity });
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null && loaded.data) setText(loaded.data.text);
  }, [loaded.data, text]);
  const save = useAutosave(text ?? '', (t) => saveNotes(slug, t), text !== null);

  if (loaded.error) return <p className="text-sm text-red-600">{loaded.error.message}</p>;
  if (text === null) return <p className="text-sm text-stone-500">Loading…</p>;
  return (
    <div>
      <textarea
        data-testid="notes"
        aria-label="Notes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Anything about this project. Saves as you type."
        rows={12}
        className="w-full resize-y rounded-md border border-stone-300 bg-white p-2 text-sm leading-relaxed dark:border-stone-700 dark:bg-stone-950"
      />
      <p data-testid="notes-status" className={`h-4 text-xs ${save.state === 'error' ? 'text-red-600' : 'text-stone-500'}`}>
        {saveLabel(save.state, save.error)}
      </p>
    </div>
  );
}

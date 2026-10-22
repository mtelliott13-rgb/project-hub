// claude.ai chats filed into this project (SPEC.md, Phase 7): by their Claude
// Project, a keyword in the title, or by hand. They open in the Claude app.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fileChat } from '../api.ts';
import { Link } from '../router.tsx';
import { Action, ago } from '../ui.tsx';
import type { SectionProps } from './sections.tsx';

const how: Record<string, string> = { 'claude-project': 'its Claude Project', keyword: 'a keyword in its title', manual: 'by hand' };

export function ChatsSection({ project, run }: SectionProps) {
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const unfile = useMutation({ mutationFn: (id: string) => fileChat(id, null), onSuccess: () => void queryClient.invalidateQueries() });
  const shown = showAll ? project.chats : project.chats.slice(0, 10);
  return (
    <div className="space-y-2">
      {project.chats.length === 0 && (
        <p className="text-sm text-stone-500">
          None yet. Chats you open in Chrome land here when they're in {project.claudeProject ? "this project's Claude Project" : 'a Claude Project mapped to it'} or
          their title has one of its keywords. <Link to="/settings" className="underline">Settings</Link> has the extension and the import.
        </p>
      )}
      <ul className="divide-y divide-stone-100 text-sm dark:divide-stone-800" data-testid="project-chats">
        {shown.map((c) => (
          <li key={c.id} className="group flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate" title={`Filed by ${how[c.filedBy ?? ''] ?? '?'}`}>
              {c.title ?? <span className="text-stone-500">Untitled chat</span>}
            </span>
            {c.filedBy === 'manual' && (
              <button type="button" className="shrink-0 text-xs text-stone-500 opacity-0 group-hover:opacity-100 hover:underline" onClick={() => unfile.mutate(c.id)} title="Let its Claude Project or keywords decide again">
                Unfile
              </button>
            )}
            <span className="w-16 shrink-0 text-right text-xs text-stone-500">{ago(c.lastActiveAt)}</span>
            <span className="flex shrink-0 gap-1">
              <Action small title="Open in the Claude desktop app" onClick={() => run({ kind: 'chat', chatId: c.id })}>
                App
              </Action>
              <Action small title="Open in your browser" onClick={() => run({ kind: 'chat', chatId: c.id, in: 'browser' })}>
                Browser
              </Action>
            </span>
          </li>
        ))}
      </ul>
      {project.chats.length > 10 && (
        <button type="button" className="text-xs text-stone-500 underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${project.chats.length}`}
        </button>
      )}
    </div>
  );
}

// Settings: connections to outside services (connectors), and (SPEC.md, Phase 7) which hub project each Claude Project's chats
// file into, the claude.ai data-export import, and the Chrome extension.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchClaudeProjects, fetchProjects, importExport, mapClaudeProject, saveLanding, type Landing } from './api.ts';
import { getLanding, setLanding } from './router.tsx';
import { ago } from './ui.tsx';
import { CalendarDefaultsSection, ConnectionsSection, QuickAddParserSection } from './Connections.tsx';

const inputClass = 'rounded-md border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-950';
const card = 'rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900';
const h2 = 'mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const cp = useQuery({ queryKey: ['claude-projects'], queryFn: fetchClaudeProjects });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const active = (projects.data ?? []).filter((p) => !p.archived);
  const name = (slug: string | null) => (slug ? (projects.data?.find((p) => p.slug === slug)?.name ?? slug) : null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const map = useMutation({
    mutationFn: (v: { id: string; slug: string | null }) => mapClaudeProject(v.id, v.slug),
    onSuccess: ({ moved }) => setNote({ ok: true, text: `Saved. ${moved} chat${moved === 1 ? '' : 's'} moved.` }),
    onError: (e: Error) => setNote({ ok: false, text: e.message }),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const upload = useMutation({
    mutationFn: importExport,
    onSuccess: (r) =>
      setNote({ ok: true, text: `Imported ${r.chats} chats (${r.added} new): ${r.filed} filed into projects, ${r.inbox} in the Inbox.${r.skipped ? ` ${r.skipped} entries skipped (no id).` : ''}` }),
    onError: (e: Error) => setNote({ ok: false, text: e.message }),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const ext = cp.data?.extension;
  // Arriving from "Connect Google Calendar" on Today: go to Connections.
  useEffect(() => {
    if (location.hash === '#connections') document.getElementById('connections')?.scrollIntoView();
  }, []);

  return (
    <div className="space-y-6" data-testid="settings-page">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {note && (
        <p data-testid="settings-message" className={`rounded-md px-3 py-2 text-sm ${note.ok ? 'bg-stone-100 dark:bg-stone-900' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'}`}>
          {note.text}
        </p>
      )}

      <LandingSection />
      <ConnectionsSection />
      <CalendarDefaultsSection />
      <QuickAddParserSection />

      <section className={card}>
        <h2 className={h2}>Claude Projects</h2>
        <p className="mb-3 text-sm text-stone-500">
          A chat in a Claude Project files into the hub project chosen here. A project's <span className="font-mono">claude_project</span> link in projects.yaml
          maps one too; a choice here overrides it. Chats outside any mapped Claude Project file by their title's keywords, else the Inbox.
        </p>
        {cp.data?.claudeProjects.length === 0 && <p className="text-sm text-stone-500">None seen yet. Open a chat that's in a Claude Project, or import the export.</p>}
        <ul className="divide-y divide-stone-100 text-sm dark:divide-stone-800" data-testid="claude-projects">
          {cp.data?.claudeProjects.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <a href={`https://claude.ai/project/${c.id}`} target="_blank" rel="noreferrer" className="hover:underline">
                  {c.name ?? <span className="font-mono text-xs">{c.id}</span>}
                </a>
                <span className="ml-2 text-xs text-stone-500">
                  {c.chats} chat{c.chats === 1 ? '' : 's'}
                  {c.yamlSlug && ` · projects.yaml: ${name(c.yamlSlug)}`}
                </span>
              </span>
              <select
                aria-label={`Hub project for ${c.name ?? c.id}`}
                className={`${inputClass} w-48`}
                value={c.projectSlug ?? ''}
                disabled={map.isPending}
                onChange={(e) => map.mutate({ id: c.id, slug: e.target.value || null })}
              >
                <option value="">{c.yamlSlug ? `${name(c.yamlSlug)} (from projects.yaml)` : 'Not mapped (Inbox)'}</option>
                {active.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </section>

      <section className={card}>
        <h2 className={h2}>Import the claude.ai data export</h2>
        <p className="mb-3 text-sm text-stone-500">
          For chats from before the extension, or from the desktop and phone apps. In claude.ai: Settings → Privacy → Export data; the email's link downloads a .zip.
          Choose it here as is. The hub keeps each chat's id, title, dates and Claude Project, nothing it said; the upload is deleted once read.
        </p>
        <input
          type="file"
          aria-label="Export file"
          accept=".zip,.json,application/zip,application/json"
          disabled={upload.isPending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = '';
          }}
          className="text-sm"
        />
        {upload.isPending && <p className="mt-2 text-sm text-stone-500">Reading…</p>}
      </section>

      <section className={card} data-testid="extension">
        <h2 className={h2}>Chrome extension</h2>
        <p className="text-sm">
          {ext?.lastHeard ? (
            <>Last heard from {ago(ext.lastHeard.at)}.</>
          ) : (
            <span className="text-stone-500">Not heard from since the hub started.</span>
          )}
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-600 dark:text-stone-400">
          <li>
            In Chrome, open <span className="font-mono">chrome://extensions</span> and turn on Developer mode (top right).
          </li>
          <li>
            Load unpacked → choose <span className="font-mono">~/project-hub/extension</span>.
          </li>
          <li>
            Check its ID is <span className="font-mono">{ext?.id ?? '…'}</span>: the hub answers only that ID.
          </li>
        </ol>
      </section>
    </div>
  );
}

/** Which page the hub opens on: Today (the default) or Projects. */
function LandingSection() {
  const [value, setValue] = useState<Landing>(getLanding());
  const save = useMutation({
    mutationFn: saveLanding,
    onSuccess: (r) => {
      setValue(r.landing);
      setLanding(r.landing);
    },
  });
  const options: { v: Landing; label: string; help: string }[] = [
    { v: 'today', label: 'Today', help: 'Agenda, tasks and what to pick up' },
    { v: 'projects', label: 'Projects', help: 'The project cards and map' },
  ];
  return (
    <section aria-labelledby="landing-h" data-testid="landing-setting">
      <h2 id="landing-h" className="text-[15px] font-semibold text-ink">
        Open the hub on
      </h2>
      <div role="radiogroup" aria-labelledby="landing-h" className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.v}
            className={`flex cursor-pointer items-start gap-2 rounded-card border bg-card px-3 py-2 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${value === o.v ? 'border-accent' : 'border-line'}`}
          >
            <input type="radio" name="landing" className="mt-0.5 accent-[var(--color-accent)]" checked={value === o.v} disabled={save.isPending} onChange={() => save.mutate(o.v)} />
            <span>
              <span className="block font-medium text-ink">{o.label}</span>
              <span className="block text-[12px] text-muted">{o.help}</span>
            </span>
          </label>
        ))}
      </div>
      {save.error && (
        <p role="alert" className="mt-1 text-[13px] text-red-700 dark:text-red-300">
          {save.error.message}
        </p>
      )}
    </section>
  );
}

// A project's collector (projects.yaml `collector:`): running or not, its
// sources' health, and Start/Stop through /api/launch.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchCollector, type CollectorStatus, type SourceHealth } from '../api.ts';
import { launch } from '../launch.ts';
import { Action, ago, Modal } from '../ui.tsx';
import type { SectionProps } from './sections.tsx';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Status({ s }: { s: CollectorStatus }) {
  const dot = (cls: string) => <span className={`inline-block size-2.5 rounded-full ${cls}`} />;
  switch (s.state) {
    case 'running':
      return (
        <p className="flex items-center gap-2 text-sm">
          {dot('bg-green-500')}
          <span>
            <strong>Running</strong>
            {s.startedAt && ` since ${when(s.startedAt)} (${ago(s.startedAt).replace(' ago', '')})`} · process {s.pid} · port {s.port}
          </span>
        </p>
      );
    case 'starting':
      return <p className="flex items-center gap-2 text-sm">{dot('animate-pulse bg-amber-400')} <strong>Starting…</strong> waiting for it to open port {s.port}</p>;
    case 'stopped':
      return <p className="flex items-center gap-2 text-sm">{dot('bg-stone-400')} <strong>Stopped</strong> · not recording</p>;
    case 'port-busy':
      return (
        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
          {dot('bg-amber-500')}
          <span>
            <strong>Port {s.port} is used by another program</strong> (process {s.pid}: {s.command}), so the collector can't start.
          </span>
        </p>
      );
  }
}

const statusColour = (status: string) =>
  status === 'ok'
    ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
    : status === 'degraded'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';

function Sources({ sources }: { sources: SourceHealth[] }) {
  return (
    <ul className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="collector-sources">
      {sources.map((s) => (
        <li key={s.id} className="flex items-center gap-2" title={s.lastError ? `Last error: ${s.lastError}` : undefined}>
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${statusColour(s.status)}`}>{s.status}</span>
          <span className="min-w-0 flex-1 truncate">{s.label}</span>
          {s.lastSuccess && <span className="shrink-0 text-stone-500">{ago(s.lastSuccess)}</span>}
        </li>
      ))}
    </ul>
  );
}

export function CollectorSection({ project }: SectionProps) {
  const slug = project.slug;
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['collector', slug], queryFn: () => fetchCollector(slug), refetchInterval: 5000 });
  const [confirmStop, setConfirmStop] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const act = useMutation({
    mutationFn: (kind: 'collector-start' | 'collector-stop') => launch({ kind, slug }),
    onSuccess: (command, kind) => setResult({ ok: true, text: `${kind === 'collector-start' ? 'Started' : 'Stopped'}: ${command}` }),
    onError: (e: Error) => setResult({ ok: false, text: e.message }),
    onSettled: () => {
      setConfirmStop(false);
      void queryClient.invalidateQueries({ queryKey: ['collector', slug] });
    },
  });
  const s = status.data;
  const cfg = project.collector;

  return (
    <div className="space-y-3" data-testid="collector" data-state={s?.state}>
      {status.error && <p className="text-sm text-red-600">{status.error.message}</p>}
      {!s && !status.error && <p className="text-sm text-stone-500">Checking…</p>}
      {s && <Status s={s} />}
      {s && (
        <div className="flex gap-2">
          <Action primary disabled={s.state !== 'stopped' || act.isPending} onClick={() => act.mutate('collector-start')}>
            {act.isPending && act.variables === 'collector-start' ? 'Starting…' : 'Start'}
          </Action>
          <Action disabled={s.state !== 'running' || act.isPending} onClick={() => setConfirmStop(true)}>
            {act.isPending && act.variables === 'collector-stop' ? 'Stopping…' : 'Stop'}
          </Action>
        </div>
      )}
      {result && <p className={`font-mono text-xs break-all ${result.ok ? 'text-stone-500' : 'text-red-600'}`}>{result.text}</p>}
      {s?.state === 'running' && s.sources && <Sources sources={s.sources} />}
      {s?.state === 'running' && s.error && <p className="text-xs text-amber-700">Couldn't read its status page: {s.error}</p>}
      {cfg && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer">How Start and Stop work</summary>
          <p className="mt-1">
            Start opens a new Terminal window in {project.repos[0]?.replace(/^\/(Users|home)\/[^/]+/, '~')} running{' '}
            <code className="font-mono">{cfg.command.join(' ')}</code>, so you see its log and Ctrl+C still works. It won't start a second copy. Stop sends
            that process the same signal as Ctrl+C and waits for it to shut down cleanly. Set in projects.yaml under <code className="font-mono">collector:</code>.
          </p>
        </details>
      )}
      {confirmStop && s?.state === 'running' && (
        <Modal title={`Stop ${project.name}'s collector?`} onClose={() => setConfirmStop(false)}>
          <div className="space-y-3 text-sm">
            <p>It stops recording until you start it again. Anything that happens meanwhile is missed.</p>
            <p className="text-stone-500">
              This sends Ctrl+C to process {s.pid} ({s.command}) and waits for it to stop cleanly.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Action onClick={() => setConfirmStop(false)}>Cancel</Action>
              <Action danger disabled={act.isPending} onClick={() => act.mutate('collector-stop')}>
                {act.isPending ? 'Stopping…' : 'Stop collector'}
              </Action>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

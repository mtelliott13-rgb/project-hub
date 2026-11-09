// Career HQ's launch buttons (Open in Word, Fill application, Build packet):
// one mutation each section shares, so only one runs at a time and the result
// (Career HQ's one line, or its error plus the command to copy) is shown.
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { HubError, runCareerLaunch, type CareerLaunchKind } from '../api.ts';
import { shortenHome } from '../ui.tsx';

type Notice = { ok: boolean; text: string; output?: string; command?: string };

const WHAT: Record<CareerLaunchKind, string> = {
  'open-letter': 'Open in Word',
  'launch-apply': 'Fill application',
  'launch-build': 'Build packet',
};

/** Every Career HQ command on the page (status, approve, launches) shares this key, so all their buttons wait for one another. */
export const careerKey = (slug: string) => ['career-command', slug];
/** True while any Career HQ command runs for this project, from any section. */
export const useCareerBusy = (slug: string) => useIsMutating({ mutationKey: careerKey(slug) }) > 0;

export function useCareerLaunch(slug: string, setNotice: (n: Notice | null) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: careerKey(slug),
    mutationFn: ({ kind, id }: { kind: CareerLaunchKind; id: string; label: string }) => runCareerLaunch(kind, slug, id),
    onMutate: () => setNotice(null),
    onSuccess: (r, { kind }) =>
      setNotice({
        ok: true,
        text:
          kind === 'open-letter'
            ? r.message
            : `${r.message}. Watch it in that Terminal window; press Ctrl+C or close the window to stop it.`,
      }),
    onError: (e: Error, { kind, label }) => {
      const body = e instanceof HubError ? e.body : {};
      setNotice({
        ok: false,
        text: `${WHAT[kind]} (${label}): ${e.message}`,
        output: typeof body.output === 'string' && body.output ? body.output : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
      });
    },
    // Nothing retries. The queue, feed and card may have changed (a refused duplicate, a status), so reload them.
    onSettled: () => {
      for (const key of ['applications', 'job-feed', 'projects']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** The repo holding a queue or feed file (for copyable commands), with ~ for home. */
export function careerRepo(file: string) {
  const dir = file.replace(/\/jobs\/(queue\.yaml|queue\/review_queue\.yaml|feed\/feed\.json)$/, '');
  return shortenHome(dir);
}

/** Quotes one argument for zsh when it isn't plain. */
export const quoteArg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

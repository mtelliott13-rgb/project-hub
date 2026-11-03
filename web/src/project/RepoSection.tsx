// Commits and PRs (SPEC.md, Phase 5): each repo's branch, uncommitted files,
// ahead/behind, CI, open PRs and last 10 commits. Checked every 3 minutes and
// after every Claude turn; Refresh checks now.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refreshRepos, type RepoStatus } from '../api.ts';
import { Action, ago, shortenHome } from '../ui.tsx';
import type { SectionProps } from './sections.tsx';

type Check = NonNullable<RepoStatus['github']>['prs'][number]['checks'];

export const checkLook: Record<Check, { label: string; cls: string; text: string }> = {
  passing: { label: 'CI passing', cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300', text: 'font-medium text-green-700 dark:text-green-400' },
  failing: { label: 'CI failing', cls: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', text: 'font-medium text-red-700 dark:text-red-400' },
  pending: { label: 'CI running', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', text: 'font-medium text-amber-700 dark:text-amber-400' },
  none: { label: 'no CI', cls: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300', text: '' },
};

const Chip = ({ cls, children }: { cls: string; children: string }) => (
  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>
);

/** Branch · uncommitted · ahead/behind · PRs (CI is shown beside it, coloured). Cards pass `badged: false` to skip what their badges already say. */
export function repoFacts(s: RepoStatus, { badged = true }: { badged?: boolean } = {}): string[] {
  const g = s.git;
  if (!g) return [];
  const facts = [g.branch ?? 'detached HEAD'];
  if (badged && g.uncommitted) facts.push(`${g.uncommitted} uncommitted`);
  if (!g.tracking) facts.push(s.github || g.remoteUrl ? 'not pushed' : 'no remote');
  if (badged && g.ahead) facts.push(`${g.ahead} to push`);
  if (g.behind) facts.push(`${g.behind} to pull`);
  if (badged && s.github?.prs.length) facts.push(`${s.github.prs.length} open PR${s.github.prs.length === 1 ? '' : 's'}`);
  return facts;
}

function Repo({ dir, s, project, run }: { dir: string; s: RepoStatus | null; project: SectionProps['project']; run: SectionProps['run'] }) {
  const gh = s?.github;
  const commitUrl = (hash: string) => (gh ? `https://github.com/${gh.repo}/commit/${hash}` : null);
  return (
    <div className="space-y-2" data-testid="repo" data-dir={dir}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-sm">{shortenHome(dir)}</span>
        {gh && (
          <a href={`https://github.com/${gh.repo}`} target="_blank" rel="noreferrer" className="text-xs text-stone-500 underline">
            {gh.repo}
          </a>
        )}
      </div>
      {!s && <p className="text-sm text-stone-500">Checking…</p>}
      {s?.gitError && <p className="text-sm text-red-600">{s.gitError}</p>}
      {s?.git && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="repo-facts">
            {repoFacts(s).map((f) => (
              <span key={f} className="rounded bg-stone-100 px-1.5 py-0.5 text-xs dark:bg-stone-800">
                {f}
              </span>
            ))}
            {gh?.ci && <Chip cls={checkLook[gh.ci.state].cls}>{checkLook[gh.ci.state].label}</Chip>}
            {gh?.ci && (
              <a href={gh.ci.url} target="_blank" rel="noreferrer" className="text-xs text-stone-500 underline">
                {gh.ci.workflow}, {ago(gh.ci.at)}
              </a>
            )}
          </div>
          {s.githubError && <p className="text-xs text-amber-700">GitHub: {s.githubError}</p>}
          {gh && (
            <div>
              <h3 className="text-xs font-medium text-stone-500">Open PRs ({gh.prs.length})</h3>
              {gh.prs.length === 0 ? (
                <p className="text-sm text-stone-500">None</p>
              ) : (
                <ul className="divide-y divide-stone-100 text-sm dark:divide-stone-800" data-testid="prs">
                  {gh.prs.map((pr) => (
                    <li key={pr.number} className="flex items-center gap-2 py-1">
                      <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">
                        #{pr.number} {pr.title}
                        {pr.draft && <span className="text-stone-500"> (draft)</span>}
                      </a>
                      <span className="shrink-0 font-mono text-xs text-stone-500">{pr.branch}</span>
                      <Chip cls={checkLook[pr.checks].cls}>{checkLook[pr.checks].label}</Chip>
                      <Action small title={`claude --from-pr ${pr.number}, in Terminal`} onClick={() => run({ kind: 'from-pr', slug: project.slug, pr: pr.number, path: dir })}>
                        Session
                      </Action>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div>
            <h3 className="text-xs font-medium text-stone-500">Last commits</h3>
            {s.git.commits.length === 0 ? (
              <p className="text-sm text-stone-500">No commits yet</p>
            ) : (
              <ul className="text-sm" data-testid="commits">
                {s.git.commits.map((c) => {
                  const url = commitUrl(c.hash);
                  return (
                    <li key={c.hash} className="flex items-center gap-2 py-0.5">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-xs text-stone-500 hover:underline">
                          {c.short}
                        </a>
                      ) : (
                        <span className="shrink-0 font-mono text-xs text-stone-500">{c.short}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      <span className="shrink-0 text-xs text-stone-500">{ago(c.date)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function RepoSection({ project, run }: SectionProps) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => refreshRepos(project.slug),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
  if (project.repos.length === 0) return <p className="text-sm text-stone-500">This project has no repos. Add one with Edit.</p>;
  const checked = project.repoStatus.map((s) => s?.checkedAt).filter((x): x is string => !!x).sort()[0];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-stone-500">
        <span className="flex-1">
          {checked ? `Checked ${ago(checked)}` : 'Not checked yet'}. Every 3 minutes and after each Claude turn; "to pull" counts only what your last fetch saw.
        </span>
        <Action small disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Checking…' : 'Refresh'}
        </Action>
      </div>
      {refresh.error && <p className="text-sm text-red-600">{refresh.error.message}</p>}
      {project.repos.map((dir, i) => (
        <Repo key={dir} dir={dir} s={project.repoStatus[i] ?? null} project={project} run={run} />
      ))}
    </div>
  );
}

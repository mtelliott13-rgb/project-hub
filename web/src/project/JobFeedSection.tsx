// Job feed: Career HQ's jobs/feed/feed.json (read only; Career HQ's
// job_feed.py writes it). Postings in the feed's own order (new first), with
// the flags SPEC.md asks for. "Build packet" runs Career HQ's launch-build,
// which opens a Terminal window running Claude Code's /build-packet for that
// posting; it's offered only where the queue has no packet for the posting.
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { feedOk, fetchJobFeed, type Posting } from '../api.ts';
import { Action, shortenHome } from '../ui.tsx';
import { Notice, type NoticeValue } from './ApplicationsSection.tsx';
import { useCareerBusy, useCareerLaunch } from './career-launch.ts';
import type { SectionProps } from './sections.tsx';

const PREVIEW = 25;

const fmtDate = (ymd: string | null) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const matches = (p: Posting, q: string) => !q || [p.company, p.title, p.location ?? '', p.level ?? ''].some((s) => s.toLowerCase().includes(q));

function Flag({ children, tone, title }: { children: string; tone: 'green' | 'amber' | 'stone'; title?: string }) {
  const look = {
    green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    stone: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400',
  }[tone];
  return (
    <span className={`rounded-full px-1.5 py-px text-[11px] font-medium ${look}`} title={title}>
      {children}
    </span>
  );
}

function Row({ p, busy, launching, onBuild }: { p: Posting; busy: boolean; launching: boolean; onBuild: () => void }) {
  const facts = [p.location, p.level, p.ageDays !== null && `${p.ageDays}d old`, p.source].filter(Boolean);
  return (
    <li data-testid="posting-row" data-id={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium">{p.title}</span>
          <span className="text-sm text-stone-600 dark:text-stone-400">{p.company}</span>
          {p.isNew && <Flag tone="green">new</Flag>}
          {p.reposted > 0 && (
            <Flag tone="amber" title="The same job was posted again">
              {`reposted${p.reposted > 1 ? ` ${p.reposted}×` : ''}`}
            </Flag>
          )}
          {p.locationReason === 'us_internship_season_not_stated' && <Flag tone="amber">season not stated</Flag>}
          {p.open30Plus && <Flag tone="stone">open 30+ days</Flag>}
          {p.fit && <Flag tone="stone">{`fit: ${p.fit}`}</Flag>}
        </p>
        <p className="flex flex-wrap gap-x-2 text-xs text-stone-500">
          {facts.map((f) => (
            <span key={String(f)}>{f}</span>
          ))}
          {p.url && (
            <a href={p.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:underline">
              posting <ExternalLink size={11} aria-hidden />
            </a>
          )}
          {p.applyUrl && p.applyUrl !== p.url && (
            <a href={p.applyUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:underline">
              apply page <ExternalLink size={11} aria-hidden />
            </a>
          )}
        </p>
      </div>
      {p.packet ? (
        <span className="shrink-0 text-xs text-stone-500" data-testid="has-packet">
          Packet: <span className="font-mono">{p.packet}</span>
        </span>
      ) : p.idOk ? (
        <Action
          small
          disabled={busy}
          title="Runs Career HQ's launch-build: a new Terminal window running Claude Code's /build-packet for this posting. It uses your Claude plan's usage, and stops at draft for your review."
          onClick={onBuild}
        >
          {launching ? 'Opening Terminal…' : 'Build packet'}
        </Action>
      ) : (
        <span className="shrink-0 text-xs text-amber-700" title="Not a <system>:<board>:<job id> posting id">
          ⚠ odd posting id
        </span>
      )}
    </li>
  );
}

export function JobFeedSection({ project }: SectionProps) {
  const slug = project.slug;
  const feed = useQuery({ queryKey: ['job-feed', slug], queryFn: () => fetchJobFeed(slug) });
  const [notice, setNotice] = useState<NoticeValue | null>(null);
  const [filter, setFilter] = useState('');
  const [all, setAll] = useState(false);
  const launch = useCareerLaunch(slug, setNotice);
  const busy = useCareerBusy(slug);

  const f = feed.data;
  if (feed.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (feed.error) return <p className="text-sm text-red-600">{feed.error.message}</p>;
  if (!f) return null;
  if (!feedOk(f)) return <p className="text-sm text-red-600">{'error' in f ? f.error : "The job feed can't be read"}</p>;

  const q = filter.trim().toLowerCase();
  const shown = f.postings.filter((p) => matches(p, q));
  const visible = all || q ? shown : shown.slice(0, PREVIEW);
  const withPacket = f.postings.filter((p) => p.packet).length;
  return (
    <div className="space-y-3" data-testid="job-feed">
      <p className="text-sm">
        <strong>
          {f.postings.length} posting{f.postings.length === 1 ? '' : 's'}
        </strong>
        <span className="text-stone-500">
          {f.counts.new > 0 && ` · ${f.counts.new} new`}
          {f.counts.reposted > 0 && ` · ${f.counts.reposted} reposted`}
          {withPacket > 0 && ` · ${withPacket} with a packet`}
          {f.generated && ` · generated ${fmtDate(f.generated)}`} · from {shortenHome(f.file)}
        </span>
      </p>
      {f.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
          ⚠ {w}
        </p>
      ))}
      {f.others.length > 0 && <p className="text-xs text-amber-700">Also found {f.others.map(shortenHome).join(', ')}; only the first is used.</p>}
      {f.failedRuns.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          ⚠ Couldn't read: {f.failedRuns.map((r) => (r.error ? `${r.company} (${r.error})` : r.company)).join(' · ')}
        </p>
      )}
      {launch.isPending && (
        <p className="inline-flex items-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-900 dark:text-stone-300" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Running Career HQ's launch-build command…
        </p>
      )}
      {notice && <Notice notice={notice} />}
      {f.postings.length > 0 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by company, title, location or level"
          aria-label="Filter postings"
          className="h-8 w-full rounded-md border border-stone-300 bg-transparent px-2 text-sm dark:border-stone-700"
        />
      )}
      <ul className="divide-y divide-stone-100 dark:divide-stone-800">
        {visible.map((p) => (
          <Row
            key={p.id}
            p={p}
            busy={busy}
            launching={launch.isPending && launch.variables?.id === p.id}
            onBuild={() => launch.mutate({ kind: 'launch-build', id: p.id, label: `${p.company} · ${p.title}` })}
          />
        ))}
      </ul>
      {q && shown.length === 0 && <p className="text-sm text-stone-500">No posting matches "{filter}".</p>}
      {!q && !all && shown.length > PREVIEW && (
        <button type="button" onClick={() => setAll(true)} className="text-sm text-stone-600 hover:underline dark:text-stone-400">
          Show all {shown.length}
        </button>
      )}
      {f.postings.length === 0 && <p className="text-sm text-stone-500">No postings right now.</p>}
      {f.notCovered.length > 0 && (
        <div>
          <h3 className="text-xs font-medium tracking-wide text-stone-500 uppercase">Check these by hand ({f.notCovered.length})</h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {f.notCovered.map((n) => (
              <li key={n.company}>
                {n.checkUrl ? (
                  <a href={n.checkUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">
                    {n.company}
                  </a>
                ) : (
                  n.company
                )}
                {n.uses && <span className="text-xs text-stone-500"> · {n.uses}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {f.attribution.map((a) => (
        <p key={a} className="text-xs text-stone-500">
          {a}
        </p>
      ))}
    </div>
  );
}

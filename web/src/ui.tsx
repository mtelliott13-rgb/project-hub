// Small shared pieces of the page: the v4 primitives (Card, Pill, ProjectChip,
// IconButton, PrimaryButton, Kbd, CollapsibleSection, useCountUp) and the older
// helpers the sections use. Colours come from the tokens in index.css.
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { initials, projectColor, tint } from './colors.ts';

export { projectColor } from './colors.ts';

export const shortenHome = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

export const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ---------------------------------------------------------------------------
// Hooks

/** True when the visitor asked for less motion. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: the page still works, it just forgets.
  }
};

/** A boolean remembered in this browser (localStorage). */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const v = read(key);
    return v === null ? fallback : v === '1';
  });
  const set = (v: boolean) => {
    setValue(v);
    write(key, v ? '1' : '0');
  };
  return [value, set];
}

/** A string list remembered in this browser, shared live between components using the same key. */
export function useStoredList(key: string): [string[], (v: string[]) => void] {
  const parse = () => {
    try {
      const v = JSON.parse(read(key) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const [list, setList] = useState(parse);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === key && setList(parse());
    addEventListener('hub:stored', on);
    return () => removeEventListener('hub:stored', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: string[]) => {
    write(key, JSON.stringify(v));
    setList(v);
    dispatchEvent(new CustomEvent('hub:stored', { detail: key }));
  };
  return [list, set];
}

/**
 * Counts up to `target` over about 1.1 s the first time it's shown, then
 * follows it. Skipped under reduced motion.
 */
export function useCountUp(target: number, duration = 1100): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? target : 0);
  const done = useRef(false);
  useEffect(() => {
    if (reduced || done.current || target === 0) {
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
      else done.current = true;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);
  return value;
}

// ---------------------------------------------------------------------------
// Primitives

export function Card({ children, className = '', as: Tag = 'div', style, ...rest }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'li' | 'article'; style?: CSSProperties } & Record<`data-${string}`, string | undefined>) {
  return (
    <Tag className={`rounded-card border border-line bg-card shadow-card ${className}`} style={style} {...rest}>
      {children}
    </Tag>
  );
}

type Tone = 'live' | 'warn' | 'neutral' | 'accent' | 'danger' | 'idle';
const toneClass: Record<Tone, string> = {
  live: 'bg-live-bg text-live',
  warn: 'bg-warn-bg text-warn',
  idle: 'bg-warn-bg text-warn',
  neutral: 'bg-track text-muted',
  accent: 'bg-accent/10 text-accent',
  danger: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
};

/** A rounded label. Status is never colour alone: pass the words (and an icon if useful). */
export function Pill({ tone = 'neutral', children, className = '', title, ...rest }: { tone?: Tone; children: ReactNode; className?: string; title?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${toneClass[tone]} ${className}`} {...rest}>
      {children}
    </span>
  );
}

/** A small green dot that pings while something is live. `idle` is amber and still. */
export function PingDot({ idle, size = 8 }: { idle?: boolean; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden>
      {!idle && <span className="hub-ping absolute inset-0 rounded-full bg-live-dot opacity-60" />}
      <span className={`relative inline-flex size-full rounded-full ${idle ? 'bg-amber-500' : 'bg-live-dot'}`} />
    </span>
  );
}

/** The project's rounded-square chip: its colour at 13% behind initials in the deep shade. */
export function ProjectChip({ slug, name, size = 32, className = '' }: { slug: string; name: string; size?: number; className?: string }) {
  const c = projectColor(slug);
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center font-semibold select-none ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: tint(c.base, 0.13), color: c.deep, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

/** A small key-hint badge. */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={`inline-flex min-w-[18px] items-center justify-center rounded-[5px] border border-control bg-soft px-1 font-sans text-[10.5px] leading-[16px] font-medium text-muted ${className}`}>
      {children}
    </kbd>
  );
}

/** An icon-only button. `label` is read out and shown as the tooltip. */
export function IconButton({ label, onClick, children, disabled, className = '', pressed }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean; className?: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-control bg-card text-muted transition hover:border-accent/40 hover:bg-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

/** The accent button with its glow, for the one main action on a card or page. */
export function PrimaryButton({ children, onClick, disabled, title, hint, hintOnHover, className = '', testId }: { children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; hint?: string; hintOnHover?: boolean; className?: string; testId?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={`group/primary inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-white shadow-glow transition hover:-translate-y-px hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none disabled:hover:translate-y-0 ${className}`}
    >
      {children}
      {hint && (
        <kbd
          className={`rounded-[4px] bg-white/20 px-1 font-sans text-[10.5px] leading-4 font-medium text-white ${hintOnHover ? 'opacity-0 transition-opacity group-hover/primary:opacity-100 group-focus-visible/primary:opacity-100' : ''}`}
          aria-hidden
        >
          {hint}
        </kbd>
      )}
    </button>
  );
}

/** A plain secondary button with an optional icon, matching IconButton's height. */
export function SoftButton({ children, onClick, title, disabled, className = '' }: { children: ReactNode; onClick?: () => void; title?: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-btn border border-control bg-card px-3 text-[13px] font-medium text-ink transition hover:border-accent/40 hover:bg-soft disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

/** Opens or closes every CollapsibleSection with this scope (Expand all / Collapse all). */
export const setAllSections = (scope: string, open: boolean) => dispatchEvent(new CustomEvent('hub:sections', { detail: { scope, open } }));

/**
 * A section whose header button folds it away. Open or closed is remembered in
 * this browser per scope (a project slug, or "home") and id. When closed, the
 * header shows a one-line summary on the right.
 */
export function CollapsibleSection({
  scope,
  id,
  title,
  summary,
  hint,
  defaultOpen = true,
  count,
  children,
  framed = true,
  className = '',
  headingLevel = 2,
  ...rest
}: {
  scope: string;
  id: string;
  title: ReactNode;
  summary?: ReactNode;
  /** Shown on the right while open (e.g. "Autosaves"). */
  hint?: ReactNode;
  defaultOpen?: boolean;
  count?: number;
  children: ReactNode;
  framed?: boolean;
  className?: string;
  headingLevel?: 2 | 3;
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useStoredFlag(`project-hub:open:${scope}:${id}`, defaultOpen);
  // Once opened, the body stays mounted (just hidden), so text being edited
  // inside (notes, drafts) keeps its state when the section is closed.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ scope: string; open: boolean }>).detail;
      if (d.scope === scope) setOpen(d.open);
    };
    addEventListener('hub:sections', on);
    return () => removeEventListener('hub:sections', on);
  });
  const bodyId = `section-${scope}-${id}`;
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const header = (
    <H className="m-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-2 text-left ${framed ? 'px-4 py-3' : 'py-1.5'}`}
      >
        <ChevronRight size={16} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={framed ? 'text-[15px] font-semibold' : 'text-[13px] font-semibold tracking-wide text-ink uppercase'}>{title}</span>
        {count !== undefined && <Pill tone="neutral">{count}</Pill>}
        {!framed && <span className="h-px flex-1 bg-line" aria-hidden />}
        {framed && <span className="flex-1" />}
        {!open && summary && <span className="max-w-[60%] truncate text-right text-meta text-muted">{summary}</span>}
        {open && hint && <span className="text-tiny text-muted">{hint}</span>}
      </button>
    </H>
  );
  const body = (
    <div id={bodyId} hidden={!open} className={framed ? 'border-t border-line px-4 pt-3 pb-4' : 'pt-2'}>
      {opened && children}
    </div>
  );
  if (!framed)
    return (
      <section className={className} {...rest}>
        {header}
        {body}
      </section>
    );
  return (
    <Card as="section" className={className} {...rest}>
      {header}
      {body}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Older helpers, restyled to the tokens.

export function Action({
  children,
  onClick,
  title,
  primary,
  danger,
  small,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const look = danger
    ? 'bg-red-700 text-white hover:bg-red-600'
    : primary
      ? 'bg-accent text-white shadow-glow hover:brightness-110'
      : 'border border-control bg-card text-ink hover:border-accent/40 hover:bg-soft';
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${look} ${small ? 'rounded-[7px] px-1.5 py-0.5 text-xs' : 'rounded-[9px] px-3 py-1 text-[13px]'}`}
    >
      {children}
    </button>
  );
}

/** A quiet text button, for menus and inline actions. */
export function TextButton({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" title={title} onClick={onClick} className="text-xs text-muted hover:text-ink hover:underline">
      {children}
    </button>
  );
}

export function Badge({ className, children }: { className: string; children: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function Row({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted">{label}</dt>
      <dd className="font-mono break-all">{values.join(', ')}</dd>
    </div>
  );
}

/** A centred panel over a dimmed page. Escape or a click outside closes it. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-[#0f1216]/40 px-4 py-10"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div role="dialog" aria-label={title} className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} hub-fade-up rounded-header border border-line bg-card p-5 shadow-lift`}>
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

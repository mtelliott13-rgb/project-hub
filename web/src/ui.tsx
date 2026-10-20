// Small shared pieces of the page.
import type { ReactNode } from 'react';

export const shortenHome = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

export const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

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
      ? 'bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300'
      : 'border border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800';
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-40 ${look} ${small ? 'px-1.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'}`}
    >
      {children}
    </button>
  );
}

/** A quiet text button, for card menus. */
export function TextButton({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" title={title} onClick={onClick} className="text-xs text-stone-500 hover:text-stone-900 hover:underline dark:hover:text-stone-100">
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
      <dt className="w-20 shrink-0 text-stone-500">{label}</dt>
      <dd className="font-mono break-all">{values.join(', ')}</dd>
    </div>
  );
}

/** A centred panel over a dimmed page. Escape or a click outside closes it. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-10"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg bg-white p-5 shadow-xl dark:bg-stone-900`}
      >
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

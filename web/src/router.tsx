// A tiny router: /, /p/<slug> and /ideas. The hub serves index.html for every
// page path, so these URLs can be bookmarked and reloaded.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';

const subscribe = (cb: () => void) => {
  addEventListener('popstate', cb);
  return () => removeEventListener('popstate', cb);
};

export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname);

export function navigate(to: string) {
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo(0, 0);
}

export type Route = { page: 'home' } | { page: 'project'; slug: string } | { page: 'ideas' };

export function route(path: string): Route {
  const project = path.match(/^\/p\/([a-z0-9-]+)\/?$/);
  if (project) return { page: 'project', slug: project[1] };
  if (/^\/ideas\/?$/.test(path)) return { page: 'ideas' };
  return { page: 'home' };
}

/** A normal link that moves within the page; Cmd-click still opens a new tab. */
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

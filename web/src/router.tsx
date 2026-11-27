// A tiny router: /, /today, /projects, /p/<slug>, /ideas, /inbox and /settings.
// / opens Today or Projects, as chosen in Settings (the server puts the choice in
// a meta tag, so the first paint is already the right page). The hub serves index.html for every
// page path, so these URLs can be bookmarked and reloaded.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

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

export type Route = { page: 'today' } | { page: 'home' } | { page: 'project'; slug: string } | { page: 'ideas' } | { page: 'inbox' } | { page: 'settings' };

let landing: 'today' | 'projects' =
  typeof document !== 'undefined' && document.querySelector<HTMLMetaElement>('meta[name="hub-landing"]')?.content === 'projects' ? 'projects' : 'today';
/** Which page / shows; Settings changes it without a reload. */
export const getLanding = () => landing;
export function setLanding(next: 'today' | 'projects') {
  landing = next;
  dispatchEvent(new PopStateEvent('popstate'));
}

export function route(path: string, home: 'today' | 'projects' = landing): Route {
  const project = path.match(/^\/p\/([a-z0-9-]+)\/?$/);
  if (project) return { page: 'project', slug: project[1] };
  if (/^\/ideas\/?$/.test(path)) return { page: 'ideas' };
  if (/^\/inbox\/?$/.test(path)) return { page: 'inbox' };
  if (/^\/settings\/?$/.test(path)) return { page: 'settings' };
  if (/^\/today\/?$/.test(path)) return { page: 'today' };
  if (/^\/projects\/?$/.test(path)) return { page: 'home' };
  return home === 'projects' ? { page: 'home' } : { page: 'today' };
}

/** A normal link that moves within the page; Cmd-click still opens a new tab. */
export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a {...rest} href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

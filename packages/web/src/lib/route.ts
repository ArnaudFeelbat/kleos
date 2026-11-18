import { useSyncExternalStore } from 'react';

/** Two screens, each in its own window: the start window and one workspace per connection. */
export type Route = { name: 'connections' } | { name: 'workspace'; sid: string };

export function parseRoute(hash: string): Route {
  const match = /^#\/w\/([^/?#]+)/.exec(hash);
  if (match?.[1]) return { name: 'workspace', sid: decodeURIComponent(match[1]) };
  return { name: 'connections' };
}

export function workspaceHash(sid: string): string {
  return `#/w/${encodeURIComponent(sid)}`;
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

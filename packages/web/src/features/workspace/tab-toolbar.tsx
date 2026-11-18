import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace, type WorkspaceTab } from './context';

/** The right side of the tab bar; each tab portals its own controls into it while active. */
export const TabToolbarSlotContext = createContext<HTMLElement | null>(null);

/**
 * Renders `children` into the tab bar's right side, only while `tab` is the active tab.
 * Tabs that never use it (Data, Query) simply leave the slot empty.
 */
export function TabToolbar({ tab, children }: { tab: WorkspaceTab; children: ReactNode }) {
  const slot = useContext(TabToolbarSlotContext);
  const { activeTab } = useWorkspace();
  if (!slot || activeTab !== tab) return null;
  return createPortal(children, slot);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** True while the window is visible (document.visibilityState), so polling can stop when hidden. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden');
}

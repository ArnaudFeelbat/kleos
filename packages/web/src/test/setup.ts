import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetBridgeStores } from '@/lib/settings';

afterEach(() => {
  cleanup();
  // Settings and the update state are mirrored once per page; each test starts from its own bridge.
  resetBridgeStores();
});

// jsdom lacks these; Radix and React Flow touch them.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// cmdk scrolls the active item into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

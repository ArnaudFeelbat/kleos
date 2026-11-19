import { defaultSettings, type Settings, type UpdateState } from '@kleos/shared';
import { useEffect, useSyncExternalStore } from 'react';
import type { KleosBridge } from './bridge';

/**
 * A value the main process owns and broadcasts (settings, the update state), mirrored once per
 * page: the first read loads it, then every broadcast replaces it. Without a bridge (tests, a
 * plain browser) the fallback stands in, so the page still works with the defaults.
 */
function bridgeStore<T>(
  fallback: T,
  load: (bridge: KleosBridge) => Promise<T>,
  listen: (bridge: KleosBridge, listener: (value: T) => void) => () => void,
) {
  let current: T | null = null;
  let loading: Promise<T> | null = null;
  let unlisten: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (value: T) => {
    current = value;
    for (const l of listeners) l();
  };

  /** The value, loaded on first call (later calls share that load). Never rejects. */
  function ensure(): Promise<T> {
    if (current !== null) return Promise.resolve(current);
    if (loading) return loading;
    const bridge = window.kleos;
    // The bridge may predate 0.5 (a mock with only some members): treat it as absent.
    if (!bridge || typeof bridge.onSettingsChanged !== 'function') return Promise.resolve(fallback);
    // Subscribe before loading, so a change broadcast during the load is not lost.
    unlisten = listen(bridge, set);
    const pending = load(bridge)
      .then((value) => {
        // A broadcast may already have answered with something newer.
        if (current === null) set(value);
        return current ?? value;
      })
      .catch(() => current ?? fallback);
    loading = pending;
    return pending;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const snapshot = () => current ?? fallback;

  function use(): T {
    const value = useSyncExternalStore(subscribe, snapshot);
    useEffect(() => {
      void ensure();
    }, []);
    return value;
  }

  /** True once the real value is known (loaded or broadcast), so defaults never pass for a decision. */
  function useLoaded(): boolean {
    const loaded = useSyncExternalStore(subscribe, () => current !== null);
    useEffect(() => {
      void ensure();
    }, []);
    return loaded;
  }

  function reset() {
    unlisten?.();
    unlisten = null;
    current = null;
    loading = null;
    for (const l of listeners) l();
  }

  return { ensure, use, useLoaded, snapshot, reset, set };
}

const settingsStore = bridgeStore<Settings>(
  defaultSettings,
  (b) => b.getSettings(),
  (b, l) => b.onSettingsChanged(l),
);

const updateStore = bridgeStore<UpdateState | null>(
  null,
  (b) => b.getUpdateState(),
  (b, l) => b.onUpdateState(l),
);

/** The app settings, live: the defaults until loaded, then every change from any window. */
export const useSettings = settingsStore.use;

/** Whether the settings have been read from the main process yet. */
export const useSettingsLoaded = settingsStore.useLoaded;

/** The settings once loaded (the defaults without a bridge), for code outside React's render. */
export const loadSettings = settingsStore.ensure;

/** The update check's state, live; null until known (or without a bridge). */
export const useUpdateState = updateStore.use;

/**
 * Saves a change through the main process, which validates, stores and broadcasts it; the
 * broadcast is what updates every window, this one included. Resolves to the settings in force.
 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings | null> {
  const bridge = window.kleos;
  if (!bridge || typeof bridge.updateSettings !== 'function') return null;
  const settings = await bridge.updateSettings(patch);
  // Usually already broadcast; applying the answer too keeps this window right if it is not.
  settingsStore.set(settings);
  return settings;
}

/**
 * Asks GitHub now, whatever Settings › updateChecks says (the user asked). The main process
 * broadcasts `checking` then the outcome; the answer is applied too, as for updateSettings.
 */
export async function checkForUpdates(): Promise<UpdateState | null> {
  const bridge = window.kleos;
  if (!bridge || typeof bridge.checkForUpdates !== 'function') return null;
  const state = await bridge.checkForUpdates();
  updateStore.set(state);
  return state;
}

/** Tests only: forgets the mirrored values and unsubscribes from the bridge. */
export function resetBridgeStores(): void {
  settingsStore.reset();
  updateStore.reset();
}

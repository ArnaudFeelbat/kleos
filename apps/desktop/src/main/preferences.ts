import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySettingsPatch, readStoredSettings, type Settings } from '@kleos/shared';

export type Appearance = Settings['appearance'];

export function isAppearance(value: unknown): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark';
}

type Listener = (next: Settings, previous: Settings) => void;

export type SettingsStore = {
  get(): Settings;
  /** Merges, validates (throws on an invalid patch, changing nothing), saves, then notifies. */
  update(patch: unknown): Settings;
  onChange(listener: Listener): void;
};

/**
 * App settings kept in preferences.json beside app.db (not secrets, not per connection).
 * A 0.4 file holding only `{ appearance }` keeps its appearance; the rest starts at the defaults.
 */
export function openSettingsStore(dataDir: string): SettingsStore {
  const file = join(dataDir, 'preferences.json');
  let current = load(file);
  const listeners: Listener[] = [];
  return {
    get: () => current,
    update(patch) {
      const previous = current;
      current = applySettingsPatch(previous, patch);
      save(file, current);
      for (const listener of listeners) listener(current, previous);
      return current;
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

function load(file: string): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Missing on first launch, or unreadable: start from the defaults.
  }
  return readStoredSettings(raw);
}

function save(file: string, settings: Settings): void {
  try {
    writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch (err) {
    // The change still applies for this run; it just won't survive a relaunch.
    console.error('[kleos] could not save preferences', err);
  }
}

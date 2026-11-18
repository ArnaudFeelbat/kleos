import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Appearance = 'system' | 'light' | 'dark';

export type Preferences = { appearance: Appearance };

const defaults: Preferences = { appearance: 'system' };

export function isAppearance(value: unknown): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Window preferences kept beside app.db (not secrets, not per connection). */
export function loadPreferences(dataDir: string): Preferences {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'preferences.json'), 'utf8'));
    const appearance = (raw as { appearance?: unknown })?.appearance;
    return { ...defaults, appearance: isAppearance(appearance) ? appearance : defaults.appearance };
  } catch {
    return { ...defaults };
  }
}

export function savePreferences(dataDir: string, prefs: Preferences): void {
  try {
    writeFileSync(join(dataDir, 'preferences.json'), JSON.stringify(prefs, null, 2));
  } catch (err) {
    console.error('[kleos] could not save preferences', err);
  }
}

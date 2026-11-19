import { Settings } from './settings';

/**
 * How the main process reads and changes Settings (0.5). Pure, so it is tested here; the main
 * process only adds the file and the broadcast.
 */

/**
 * Settings from whatever preferences.json holds. Field by field, so one unreadable value (an
 * older or hand-edited file) falls back to its default without losing the others — a 0.4 file
 * holding only `{ appearance }` keeps its appearance.
 */
export function readStoredSettings(raw: unknown): Settings {
  const stored = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const fields = Object.entries(Settings.shape).map(([key, schema]) => {
    const parsed = schema.safeParse(stored[key]);
    return [key, parsed.success ? parsed.data : schema.parse(undefined)];
  });
  return Settings.parse(Object.fromEntries(fields));
}

/**
 * The settings after `patch`, validated as a whole. Throws on a patch that is not an object or
 * holds an invalid value: a bad patch changes nothing. Keys set to undefined are ignored, and
 * unknown keys are dropped.
 */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Settings patch must be an object.');
  }
  const defined = Object.entries(patch).filter(([, value]) => value !== undefined);
  const result = Settings.safeParse({ ...current, ...Object.fromEntries(defined) });
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid setting ${issue?.path.join('.') || ''}: ${issue?.message ?? 'rejected'}`.trim());
  }
  return result.data;
}

import type { Appearance } from './bridge';

/**
 * Keeps `dark` on <html> in step with the appearance. The main process drives
 * prefers-color-scheme through nativeTheme, but Chromium only reports that change in a frame
 * the page actually renders: a window in the background (behind the Settings window or another
 * app) could repaint its CSS dark while the `change` event that sets the class waited. So the
 * class also follows the appearance setting itself, which every window hears at once.
 */
export function followSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let appearance: Appearance = 'system';
  const apply = () => {
    const dark = appearance === 'dark' || (appearance === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
  };
  apply();
  media.addEventListener('change', apply);

  const bridge = window.kleos;
  let stopSettings: (() => void) | undefined;
  if (bridge?.onSettingsChanged && bridge.getSettings) {
    stopSettings = bridge.onSettingsChanged((settings) => {
      appearance = settings.appearance;
      apply();
    });
    void bridge
      .getSettings()
      .then((settings) => {
        appearance = settings.appearance;
        apply();
      })
      .catch(() => undefined);
  }
  return () => {
    media.removeEventListener('change', apply);
    stopSettings?.();
  };
}

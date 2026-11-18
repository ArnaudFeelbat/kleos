/** Follows the macOS appearance: toggles `dark` on <html> as the system setting changes. */
export function followSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('dark', media.matches);
  apply();
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}

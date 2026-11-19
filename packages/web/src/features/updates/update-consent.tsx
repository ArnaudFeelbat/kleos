import { CircleArrowDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { updateSettings, useSettings, useSettingsLoaded } from '@/lib/settings';

/** The one-line promise shown wherever update checks are offered. */
export const updateCheckPromise =
  'Once a day, Kleos asks GitHub whether a newer version is out. Nothing else leaves your Mac.';

/** How long the window settles (restored tabs, first paint) before the question appears. */
const SETTLE_MS = 2500;
/** While a dialog is open, the question waits and looks again this often. */
const RETRY_MS = 1000;

/** True while a modal (dialog, alert, palette) is open: the card must never sit over one. */
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/**
 * First launch: until the user decides, Kleos makes no network call (updateChecks `ask`). Once
 * the window has settled, and never over a dialog, a small card in the corner asks once:
 * Check automatically → `on`, Not now → `off`. Settings › Updates can change it later.
 */
export function UpdateConsent({ settleMs = SETTLE_MS }: { settleMs?: number }) {
  const settings = useSettings();
  const loaded = useSettingsLoaded();
  const undecided = loaded && settings.updateChecks === 'ask';
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!undecided || ready) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = (delay: number) => {
      timer = setTimeout(() => {
        if (modalOpen()) attempt(RETRY_MS);
        else setReady(true);
      }, delay);
    };
    attempt(settleMs);
    return () => clearTimeout(timer);
  }, [undecided, ready, settleMs]);

  if (!undecided || !ready) return null;

  const decide = (updateChecks: 'on' | 'off') => {
    setSaving(true);
    void updateSettings({ updateChecks })
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  return (
    <section
      aria-labelledby="update-consent-title"
      className="surface-overlay animate-in fade-in-0 slide-in-from-bottom-2 fixed right-4 bottom-4 z-40 flex w-[340px] flex-col gap-3 rounded-xl p-4 duration-300"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-brand-soft text-brand-text flex size-8 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_var(--brand-line)]"
        >
          <CircleArrowDown className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="update-consent-title" className="text-[13px] font-semibold">
            Check for new versions?
          </h2>
          <p className="text-muted-foreground text-xs leading-relaxed">{updateCheckPromise}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => decide('off')}>
          Not now
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={() => decide('on')}>
          Check automatically
        </Button>
      </div>
    </section>
  );
}

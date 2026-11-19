import { compareVersions, type Settings, type UpdateInfo, type UpdateState } from '@kleos/shared';
import { CircleArrowDown, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorText } from '@/lib/api';
import { checkForUpdates, updateSettings, useSettings, useUpdateState } from '@/lib/settings';
import { ReleaseNotes } from './release-notes';

/** The newer release the update state reports, whatever the user decided about it. */
export function newerRelease(state: UpdateState | null): UpdateInfo | null {
  const latest = state?.latest;
  if (!state || !latest) return null;
  // `latest` may be kept while a later check runs (or fails): the release is still out there, so
  // the notice doesn't blink. Only a check that found nothing newer takes it away.
  if (state.status === 'current') return null;
  return compareVersions(latest.version, state.current) > 0 ? latest : null;
}

/** The release the title bar announces: a newer one the user has not chosen to skip. */
export function announcedRelease(state: UpdateState | null, settings: Settings): UpdateInfo | null {
  const latest = newerRelease(state);
  return latest && latest.version !== settings.skippedVersion ? latest : null;
}

/** The page a Download button opens: the DMG itself when the release has one, else its page. */
export function downloadUrl(release: UpdateInfo): string {
  return release.dmgUrl ?? release.url;
}

/**
 * ⌘K › Check for Updates in the main window: asks GitHub now and answers right here — the
 * update dialog when there is a newer release (even a skipped one: the user asked), else a toast.
 */
export async function checkForUpdatesNow(showRelease: () => void): Promise<void> {
  try {
    const state = await checkForUpdates();
    if (!state) return;
    if (newerRelease(state)) showRelease();
    else if (state.status === 'error') {
      toast.error('Couldn’t check for updates', { description: state.error ?? undefined });
    } else if (state.status === 'current') {
      toast.success('Kleos is up to date', { description: `You have ${state.current}, the latest version.` });
    }
  } catch (err) {
    toast.error('Couldn’t check for updates', { description: errorText(err) });
  }
}

type Props = {
  /** The dialog; owned by the shell so ⌘K › Check for Updates can open it too. */
  open: boolean;
  onOpenChange(open: boolean): void;
};

/**
 * The title bar's quiet "Update available" pill and its dialog: the version, what's new, and
 * Download / Skip this version / Later. Nothing shows until a check found a newer release.
 */
export function UpdateNotice({ open, onOpenChange }: Props) {
  const state = useUpdateState();
  const settings = useSettings();
  const announced = announcedRelease(state, settings);
  // The dialog may show a skipped release when the user asked for a check explicitly.
  const release = newerRelease(state);
  const current = state?.current ?? window.kleos?.appVersion ?? '';

  return (
    <>
      {announced && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="text-brand-text bg-brand-soft hover:bg-brand-soft/80 animate-in fade-in-0 mr-1 flex h-6 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[11.5px] font-medium shadow-[inset_0_0_0_1px_var(--brand-line)] duration-300"
        >
          <CircleArrowDown className="size-3.5" aria-hidden="true" />
          Update available
        </button>
      )}
      {release && (
        <UpdateDialog
          open={open}
          onOpenChange={onOpenChange}
          release={release}
          current={current}
          skipped={settings.skippedVersion === release.version}
        />
      )}
    </>
  );
}

function formatReleaseDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // The interface is English: an English date, not the Mac's locale ("19 novembre" read oddly).
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function UpdateDialog({
  open,
  onOpenChange,
  release,
  current,
  skipped,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  release: UpdateInfo;
  current: string;
  skipped: boolean;
}) {
  const released = formatReleaseDate(release.publishedAt);
  const download = () => {
    window.kleos?.openReleasePage(downloadUrl(release));
    onOpenChange(false);
  };
  const skip = () => {
    void updateSettings({ skippedVersion: release.version }).catch(() => undefined);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-[520px]" showCloseButton={false}>
        <DialogHeader className="flex-row items-center gap-3">
          <span
            aria-hidden="true"
            className="bg-brand-soft text-brand-text flex size-10 shrink-0 items-center justify-center rounded-[10px] shadow-[inset_0_0_0_1px_var(--brand-line)]"
          >
            <CircleArrowDown className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>Kleos {release.version} is available</DialogTitle>
            <DialogDescription className="text-[12.5px]">
              You have {current}.{released ? ` Released ${released}.` : ''}
            </DialogDescription>
          </div>
        </DialogHeader>
        <section aria-label="What’s new" className="flex min-h-0 flex-col gap-2">
          <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">What’s new</h3>
          <div className="bg-background/60 max-h-[min(320px,45vh)] overflow-y-auto rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--edge)] dark:bg-white/[0.03]">
            <ReleaseNotes markdown={release.notes} />
          </div>
        </section>
        <DialogFooter className="items-center sm:justify-between">
          {skipped ? (
            <span className="text-muted-foreground text-xs">You chose to skip this version.</span>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={skip}>
              Skip this version
            </Button>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Later
            </Button>
            <Button type="button" size="sm" onClick={download} autoFocus>
              <Download aria-hidden="true" />
              Download
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

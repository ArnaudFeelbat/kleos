import {
  pageSizes,
  queryTimeouts,
  type PageSize,
  type QueryTimeout,
  type Settings,
  type UpdateInfo,
  type UpdateState,
} from '@kleos/shared';
import { CircleArrowDown, Database, Download, LoaderCircle, Settings as Gear, type LucideIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive, Tabs as TabsPrimitive } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Callout } from '@/features/common/callout';
import { segmentedItem, segmentedList } from '@/features/common/styles';
import { groupDigits } from '@/features/data/table-state';
import { ReleaseNotes } from '@/features/updates/release-notes';
import { updateCheckPromise } from '@/features/updates/update-consent';
import { downloadUrl, newerRelease } from '@/features/updates/update-notice';
import type { Appearance } from '@/lib/bridge';
import { errorText } from '@/lib/api';
import { checkForUpdates, updateSettings, useSettings, useUpdateState } from '@/lib/settings';
import { cn } from '@/lib/utils';

export type SettingsPane = 'general' | 'data' | 'updates';

const panes: { id: SettingsPane; label: string; Icon: LucideIcon }[] = [
  { id: 'general', label: 'General', Icon: Gear },
  { id: 'data', label: 'Data', Icon: Database },
  { id: 'updates', label: 'Updates', Icon: CircleArrowDown },
];

/** `#updates` (or `#data`, `#general`) in the window's URL picks the pane it opens on. */
function paneFromHash(): SettingsPane | null {
  const id = window.location.hash.replace(/^#/, '');
  return panes.some((p) => p.id === id) ? (id as SettingsPane) : null;
}

/** Saves one change; the main process broadcasts it back to every window, this one included. */
function save(patch: Partial<Settings>) {
  void updateSettings(patch).catch(() => undefined);
}

/**
 * The Settings window (⌘,): a macOS preferences window — a toolbar of panes (General, Data,
 * Updates) over the selected one. Every control saves at once and follows changes made
 * elsewhere (the View menu's appearance, the main window's update question).
 */
export function SettingsWindow({ initialPane }: { initialPane?: SettingsPane }) {
  const [pane, setPane] = useState<SettingsPane>(() => initialPane ?? paneFromHash() ?? 'general');
  const label = panes.find((p) => p.id === pane)!.label;

  useEffect(() => {
    window.kleos?.setTitle(label);
  }, [label]);
  useEffect(() => {
    const follow = () => {
      const next = paneFromHash();
      if (next) setPane(next);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  return (
    <TabsPrimitive.Root
      value={pane}
      onValueChange={(v) => setPane(v as SettingsPane)}
      className="bg-pane text-foreground flex h-full flex-col"
    >
      <header className="app-drag shrink-0 border-b border-[var(--edge)] pt-1.5 pb-2">
        {/* Beside the traffic lights, as a native title would be. */}
        <h1 className="flex h-6 items-center justify-center text-[13px] font-semibold">{label}</h1>
        <TabsPrimitive.List aria-label="Settings" className="mt-1 flex justify-center gap-1">
          {panes.map(({ id, label: name, Icon }) => (
            <TabsPrimitive.Trigger
              key={id}
              value={id}
              className={cn(
                'group text-foreground/70 hover:text-foreground flex w-[72px] flex-col items-center gap-1 rounded-md px-2 pt-1.5 pb-1 text-[11.5px] font-medium outline-none',
                'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                'data-[state=active]:text-foreground data-[state=active]:bg-black/[0.07] dark:data-[state=active]:bg-white/[0.09]',
              )}
            >
              <Icon
                aria-hidden="true"
                strokeWidth={1.75}
                className="group-data-[state=active]:text-brand-text size-[22px] transition-colors"
              />
              {name}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
      </header>
      <TabsPrimitive.Content value="general" className={paneClass}>
        <GeneralPane />
      </TabsPrimitive.Content>
      <TabsPrimitive.Content value="data" className={paneClass}>
        <DataPane />
      </TabsPrimitive.Content>
      <TabsPrimitive.Content value="updates" className={paneClass}>
        <UpdatesPane />
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}

const paneClass = 'min-h-0 flex-1 overflow-y-auto px-7 py-5 outline-none flex flex-col gap-2.5';

/** A group of settings rows on a raised box, as in macOS System Settings. */
function Group({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-background/80 flex flex-col divide-y divide-[var(--edge)] rounded-lg shadow-[0_0_0_1px_var(--edge),var(--elev-1)] dark:bg-white/[0.04]',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Row({
  title,
  description,
  htmlFor,
  id,
  children,
}: {
  title: string;
  description?: ReactNode;
  htmlFor?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={id} className="text-[13px] font-medium">
            {title}
          </label>
        ) : (
          <span id={id} className="text-[13px] font-medium">
            {title}
          </span>
        )}
        {description && <span className="text-muted-foreground text-xs leading-relaxed">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-1 text-xs leading-relaxed">{children}</p>;
}

// ---- General ------------------------------------------------------------------------------

const appearances: { mode: Appearance; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

function GeneralPane() {
  const { appearance } = useSettings();
  return (
    <>
      <Group>
        <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
          <span id="appearance-label" className="text-[13px] font-medium">
            Appearance
          </span>
          <RadioGroupPrimitive.Root
            aria-labelledby="appearance-label"
            value={appearance}
            onValueChange={(mode) => save({ appearance: mode as Appearance })}
            className="flex gap-5"
          >
            {appearances.map(({ mode, label }) => (
              <RadioGroupPrimitive.Item
                key={mode}
                value={mode}
                aria-label={label}
                className="group flex flex-col items-center gap-1.5 rounded-lg outline-none"
              >
                <AppearancePreview mode={mode} />
                <span className="text-foreground/75 group-data-[state=checked]:text-foreground text-xs group-data-[state=checked]:font-medium">
                  {label}
                </span>
              </RadioGroupPrimitive.Item>
            ))}
          </RadioGroupPrimitive.Root>
        </div>
      </Group>
      <Note>System follows macOS. Light and Dark apply to every Kleos window.</Note>
    </>
  );
}

/** A tiny window drawn in the appearance's colors; System is half light, half dark. */
function AppearancePreview({ mode }: { mode: Appearance }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative block h-[52px] w-[78px] overflow-hidden rounded-[7px] shadow-[0_0_0_1px_var(--edge),var(--elev-1)] transition-shadow',
        'group-focus-visible:shadow-[0_0_0_1px_var(--edge),0_0_0_4px_color-mix(in_srgb,var(--ring)_32%,transparent)]',
        'group-data-[state=checked]:shadow-[0_0_0_2px_var(--brand),0_0_0_5px_var(--brand-soft)]',
      )}
    >
      <MiniWindow dark={mode === 'dark'} />
      {mode === 'system' && (
        <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
          <MiniWindow dark />
        </span>
      )}
    </span>
  );
}

/** Desktop and window colors are fixed: each preview shows its own mode whatever the current one. */
function MiniWindow({ dark }: { dark: boolean }) {
  const line = dark ? 'bg-white/20' : 'bg-black/12';
  return (
    <span className={cn('absolute inset-0 flex items-end justify-center', dark ? 'bg-[#2c2f36]' : 'bg-[#dde3ec]')}>
      <span
        className={cn(
          'flex h-[40px] w-[62px] overflow-hidden rounded-t-[5px] shadow-[0_0_0_0.5px_rgb(0_0_0/0.2)]',
          dark ? 'bg-[#1c1c20]' : 'bg-white',
        )}
      >
        <span className={cn('flex w-[19px] flex-col gap-[3px] p-[4px]', dark ? 'bg-[#26262b]' : 'bg-[#f1f1f4]')}>
          <span className="flex gap-[1.5px]">
            <span className="size-[3px] rounded-full bg-[#ff5f57]" />
            <span className="size-[3px] rounded-full bg-[#febc2e]" />
            <span className="size-[3px] rounded-full bg-[#28c840]" />
          </span>
          <span className={cn('h-[2px] w-full rounded-full', dark ? 'bg-[#6ea6f7]/80' : 'bg-[#2370d4]/70')} />
          <span className={cn('h-[2px] w-3/4 rounded-full', line)} />
          <span className={cn('h-[2px] w-2/3 rounded-full', line)} />
        </span>
        <span className="flex flex-1 flex-col gap-[3px] p-[5px] pt-[9px]">
          <span className={cn('h-[2px] w-3/4 rounded-full', line)} />
          <span className={cn('h-[2px] w-full rounded-full', line)} />
          <span className={cn('h-[2px] w-1/2 rounded-full', line)} />
        </span>
      </span>
    </span>
  );
}

// ---- Data ---------------------------------------------------------------------------------

export function timeoutLabel(seconds: QueryTimeout): string {
  if (seconds === 0) return 'Off';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function DataPane() {
  const { pageSize, queryTimeoutSeconds } = useSettings();
  return (
    <>
      <Group>
        <Row title="Rows per page" id="page-size-label" description="How many rows the Data tab loads at a time.">
          <ToggleGroup
            type="single"
            aria-labelledby="page-size-label"
            value={String(pageSize)}
            // Clicking the selected segment again sends ''; a page size is always set.
            onValueChange={(v) => v && save({ pageSize: Number(v) as PageSize })}
            className={cn(segmentedList, 'h-7')}
          >
            {pageSizes.map((size) => (
              <ToggleGroupItem
                key={size}
                value={String(size)}
                className={cn(segmentedItem, 'tabular min-w-12 rounded-md! px-2.5 hover:bg-transparent')}
              >
                {groupDigits(String(size))}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
        <Row
          title="Query timeout"
          htmlFor="query-timeout"
          description="Postgres stops any statement that runs longer than this."
        >
          <Select
            value={String(queryTimeoutSeconds)}
            onValueChange={(v) => save({ queryTimeoutSeconds: Number(v) as QueryTimeout })}
          >
            <SelectTrigger id="query-timeout" size="sm" className="min-w-[128px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {queryTimeouts.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {timeoutLabel(seconds)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Group>
      <Note>
        The timeout applies to servers connected after the change; reconnect a server to use it there. A statement can
        still <code className="font-mono text-[11.5px]">SET statement_timeout</code> for itself.
      </Note>
    </>
  );
}

// ---- Updates ------------------------------------------------------------------------------

/** "today at 13:40", "yesterday at 09:05", "on 12 November at 18:20" (local time). */
export function formatCheckedAt(iso: string, now: Date = new Date()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const date = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `on ${date} at ${time}`;
}

function UpdatesPane() {
  const { updateChecks } = useSettings();
  const state = useUpdateState();
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const version = state?.current ?? window.kleos?.appVersion ?? '';
  const checking = asking || state?.status === 'checking';
  const checkedAt = state?.checkedAt ? formatCheckedAt(state.checkedAt) : null;

  const checkNow = () => {
    setAsking(true);
    setFailure(null);
    checkForUpdates()
      .catch((err: unknown) => setFailure(errorText(err)))
      .finally(() => setAsking(false));
  };

  return (
    <>
      <Group>
        <div className="flex items-center justify-between gap-6 px-4 py-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[14px] font-semibold">Kleos {version}</span>
            <span className="text-muted-foreground text-xs" aria-live="polite">
              {checking ? 'Checking for updates…' : checkedAt ? `Last checked ${checkedAt}` : 'Not checked yet'}
            </span>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={checking} onClick={checkNow}>
            {checking && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            Check now
          </Button>
        </div>
      </Group>
      <CheckResult state={state} failure={failure} checking={checking} />
      <Group className="mt-2">
        <Row title="Check for new versions automatically" htmlFor="update-checks" description={updateCheckPromise}>
          <Switch
            id="update-checks"
            checked={updateChecks === 'on'}
            onCheckedChange={(on) => save({ updateChecks: on ? 'on' : 'off' })}
          />
        </Row>
      </Group>
    </>
  );
}

function CheckResult({
  state,
  failure,
  checking,
}: {
  state: UpdateState | null;
  failure: string | null;
  checking: boolean;
}) {
  const release = newerRelease(state);
  const failed = !checking && (failure !== null || state?.status === 'error');
  // A failed re-check leaves the release found earlier on screen, under the error.
  const failedCallout = failed && (
    <Callout tone="error" role="alert" title="Couldn’t check for updates">
      <span className="text-xs">{failure ?? state?.error ?? 'Unknown error'}</span>
    </Callout>
  );
  if (release) {
    return (
      <>
        {failedCallout}
        <ReleaseCard release={release} />
      </>
    );
  }
  if (failed) return failedCallout;
  if (!checking && state?.status === 'current') {
    return (
      <Callout tone="success" role="status" title="Kleos is up to date">
        <span className="text-xs">{state.current} is the latest version.</span>
      </Callout>
    );
  }
  return null;
}

function ReleaseCard({ release }: { release: UpdateInfo }) {
  return (
    <section
      aria-label={`Kleos ${release.version} is available`}
      className="bg-background/80 flex flex-col gap-3 rounded-lg p-4 shadow-[0_0_0_1px_var(--edge),var(--elev-1)] dark:bg-white/[0.04]"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <CircleArrowDown className="text-brand-text size-5 shrink-0" aria-hidden="true" />
          <span className="text-[13px] font-semibold">Kleos {release.version} is available</span>
        </div>
        <Button type="button" size="sm" onClick={() => window.kleos?.openReleasePage(downloadUrl(release))}>
          <Download aria-hidden="true" />
          Download
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase">What’s new</h2>
        <div className="max-h-[150px] overflow-y-auto pr-1">
          <ReleaseNotes markdown={release.notes} />
        </div>
      </div>
    </section>
  );
}

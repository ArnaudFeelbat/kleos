/**
 * Shared class strings for the small custom controls the features draw themselves, so they
 * match the shadcn primitives (Tabs, Button) without copying their markup.
 */

/** Segmented control track (same look as the workspace TabsList). */
export const segmentedList =
  'inline-flex items-center gap-0.5 rounded-[9px] bg-muted/80 p-[3px] shadow-[inset_0_0_0_1px_var(--edge)] dark:bg-white/[0.04]';

/** Segment: `aria-selected` (role=tab) or `data-state=on` (toggle group) marks the active one. */
export const segmentedItem = [
  'inline-flex h-6 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-foreground/60 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:size-[13px] [&_svg]:shrink-0',
  'aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-[0_0_0_1px_var(--edge),0_1px_2px_rgb(15_15_30/0.08)] aria-selected:[&_svg]:text-brand-text dark:aria-selected:bg-white/[0.09] dark:aria-selected:shadow-[inset_0_1px_0_var(--highlight),0_1px_2px_rgb(0_0_0/0.4)]',
  'data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_var(--edge),0_1px_2px_rgb(15_15_30/0.08)] data-[state=on]:[&_svg]:text-brand-text dark:data-[state=on]:bg-white/[0.09] dark:data-[state=on]:shadow-[inset_0_1px_0_var(--highlight),0_1px_2px_rgb(0_0_0/0.4)]',
].join(' ');

/** Keyboard hint inside a primary (brand-filled) button. */
export const kbdOnPrimary =
  'rounded-[4px] bg-white/18 px-1 py-px font-mono text-[10.5px] leading-none font-medium shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]';

/** Keyboard hint on a neutral surface. */
export const kbdNeutral =
  'rounded-[4px] bg-muted px-1 py-px font-mono text-[10.5px] leading-none font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--edge)]';

/** Translucent-pane field: a soft white box with a hairline edge instead of a plain input. */
export const paneField =
  'border-transparent bg-background/75 shadow-[0_0_0_1px_var(--edge),var(--elev-1)] dark:border-transparent dark:bg-white/[0.06] dark:shadow-[0_0_0_1px_var(--edge),inset_0_1px_0_var(--highlight)]';

/** Uppercase section label (sidebars, detail panels). */
export const sectionLabel = 'text-muted-foreground text-[11px] font-semibold tracking-[0.06em] uppercase';

/** Row of a list on the translucent pane, and its selected state (one idiom for every sidebar). */
export const paneRow =
  'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 hover:bg-foreground/[0.05] dark:hover:bg-white/[0.06]';
export const paneRowSelected = 'bg-brand-soft hover:bg-brand-soft dark:hover:bg-brand-soft text-foreground';

import type { ConnectionColor } from '@kleos/shared';

/** Swatch and favorites-dot colors from the design (Radix 9-step hues); `none` has no fill. */
export const connectionColorSwatch: Record<Exclude<ConnectionColor, 'none'>, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#30a46c',
  blue: '#3e63dd',
  purple: '#8e4ec6',
};

export const connectionColorLabel: Record<ConnectionColor, string> = {
  none: 'No color',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

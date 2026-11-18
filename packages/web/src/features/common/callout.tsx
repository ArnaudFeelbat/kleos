import { CircleCheck, CircleX, Info, TriangleExclamationPoint, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type CalloutTone = 'error' | 'success' | 'warning' | 'info';

const tones: Record<CalloutTone, { box: string; icon: string; Icon: LucideIcon }> = {
  error: { box: 'bg-error-bg border-error-line', icon: 'text-destructive', Icon: CircleX },
  success: { box: 'bg-success-bg border-success-line', icon: 'text-success', Icon: CircleCheck },
  warning: { box: 'bg-warning-bg border-warning-line', icon: 'text-warning', Icon: TriangleExclamationPoint },
  info: { box: 'bg-muted/60 border-border', icon: 'text-muted-foreground', Icon: Info },
};

type CalloutProps = {
  tone: CalloutTone;
  title: ReactNode;
  children?: ReactNode;
  /** Replaces the tone's default icon. */
  icon?: LucideIcon;
  role?: 'alert' | 'status' | 'note';
  className?: string;
};

/**
 * A status message box: tone icon + bold title + details. The tone is never carried by color
 * alone: every tone has its own icon and the title says what happened.
 */
export function Callout({ tone, title, children, icon, role, className }: CalloutProps) {
  const t = tones[tone];
  const Icon = icon ?? t.Icon;
  return (
    <div
      role={role}
      className={cn(
        'animate-in fade-in-0 slide-in-from-top-0.5 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 duration-200',
        t.box,
        className,
      )}
    >
      <Icon className={cn('mt-px size-4 shrink-0', t.icon)} aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <b className="font-semibold">{title}</b>
        {children}
      </div>
    </div>
  );
}

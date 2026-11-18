import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type EmptyStateProps = {
  icon: LucideIcon;
  title: ReactNode;
  /** One or two short lines under the title. */
  hint?: ReactNode;
  /** Usually one button. */
  action?: ReactNode;
  /** `sm` for sidebars and side panels, `md` for content panels. */
  size?: 'sm' | 'md';
  className?: string;
};

/**
 * The one empty state of Kleos: the icon in a raised rounded square, a title, a muted hint and an
 * optional action, centered in the space it is given.
 */
export function EmptyState({ icon: Icon, title, hint, action, size = 'md', className }: EmptyStateProps) {
  const small = size === 'sm';
  return (
    <div
      className={cn(
        'animate-in fade-in-0 flex flex-1 flex-col items-center justify-center text-center duration-200',
        small ? 'gap-2.5 px-4 py-6' : 'gap-3 p-8',
        className,
      )}
    >
      <span
        className={cn(
          'surface-raised text-muted-foreground flex shrink-0 items-center justify-center',
          small ? 'size-8 rounded-lg [&_svg]:size-4' : 'size-10 rounded-xl [&_svg]:size-[18px]',
        )}
      >
        <Icon aria-hidden="true" />
      </span>
      <div className={cn('flex flex-col gap-1', small ? 'max-w-[220px]' : 'max-w-sm')}>
        <p
          className={cn('text-foreground font-semibold tracking-[-0.01em]', small ? 'text-[12.5px]' : 'text-[13.5px]')}
        >
          {title}
        </p>
        {hint && <div className="text-muted-foreground text-xs leading-relaxed">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

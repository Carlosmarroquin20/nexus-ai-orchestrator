import { type ComponentPropsWithoutRef, forwardRef } from 'react';

import { cn } from '@/utils/cn';

/**
 * Styled native `<select>`. A native control is used deliberately over a Radix
 * portal-based listbox: the configuration forms only need single-value enum
 * selection, for which the native element is fully accessible and avoids the
 * portal/stacking overhead inside the inspector.
 */
export const Select = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<'select'>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        '[&>option]:bg-popover [&>option]:text-popover-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

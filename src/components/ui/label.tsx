import { type ComponentPropsWithoutRef, forwardRef } from 'react';

import { cn } from '@/utils/cn';

export const Label = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<'label'>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

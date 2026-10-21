import type * as React from 'react';

import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        // Design system v2: a keycap -- 4px radius, neutral fill, a hairline
        // under-edge, 11px digits/Latin (no CJK below 12px, §10.1).
        "pointer-events-none inline-flex h-4.5 min-w-4.5 select-none items-center justify-center gap-0.5 rounded-xs bg-fill-neutral px-1 font-medium font-sans text-2xs text-muted-foreground shadow-[inset_0_-1px_0_var(--border-soft)] [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn('inline-flex items-center gap-1', className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };

import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Design system v2 §7.6 / §7.8: the shell shared by the cards that dock above
 * the composer (permission, question, plan review) and by the strips (todo,
 * goal, queue). One frame, one 32px head, one body padding, one footer.
 *
 * `tone` is the only thing a caller chooses about the frame: `pending` (the
 * card is waiting on the user) tints the border clay, `risk` tints it red.
 * `strip` drops the elevation and the body padding.
 */
const dockCardVariants = cva(
  'flex min-w-0 flex-col overflow-hidden rounded-md border bg-surface-2 text-ui',
  {
    defaultVariants: { kind: 'card', tone: 'default' },
    variants: {
      kind: {
        card: 'elev-sm',
        strip: '',
      },
      tone: {
        default: 'border-border-soft',
        pending: 'border-primary/45',
        risk: 'border-destructive/45',
      },
    },
  }
);

function DockCard({
  className,
  kind,
  tone,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof dockCardVariants>) {
  return (
    <div
      className={cn(dockCardVariants({ kind, tone }), className)}
      data-slot="dock-card"
      {...props}
    />
  );
}

/** The 32px head: status icon, title, then right-aligned trailing items. */
function DockCardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex h-8 min-w-0 shrink-0 items-center gap-2 px-3', className)}
      data-slot="dock-card-header"
      {...props}
    />
  );
}

function DockCardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'min-w-0 flex-1 truncate font-semibold text-foreground text-heading',
        className
      )}
      data-slot="dock-card-title"
      {...props}
    />
  );
}

function DockCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('min-h-0 px-4 pb-3 text-muted-foreground', className)}
      data-slot="dock-card-body"
      {...props}
    />
  );
}

/** A hairline, then the actions right-aligned: secondary (ghost) before primary. */
function DockCardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-end gap-1.5 border-border-soft border-t px-2.5 py-2',
        className
      )}
      data-slot="dock-card-footer"
      {...props}
    />
  );
}

export { DockCard, DockCardBody, DockCardFooter, DockCardHeader, DockCardTitle, dockCardVariants };

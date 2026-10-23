import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

function Empty({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-6 text-balance rounded-xl border-dashed p-6 text-center md:p-12',
        className
      )}
      data-slot="empty"
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex max-w-sm flex-col items-center text-center', className)}
      data-slot="empty-header"
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  'flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'bg-transparent',
        // Design system v2: a quiet glyph, no tile, no shadow, no stacked copies.
        icon: "flex size-8 shrink-0 items-center justify-center text-foreground-faint [&_svg:not([class*='size-'])]:size-5",
      },
    },
  }
);

function EmptyMedia({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      className={cn('relative mb-2', className)}
      data-slot="empty-media"
      data-variant={variant}
      {...props}
    >
      <div className={cn(emptyMediaVariants({ className, variant }))} {...props} />
    </div>
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      // D25 §3.3 tier 5: 18px title tier is the only tier allowed negative
      // tracking. Call sites that override the size below 18px must also
      // reset to tracking-normal (see workspace-shell / layout call sites).
      className={cn('font-medium text-foreground text-ui', className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <div
      className={cn(
        'text-foreground-faint text-small [&>a:hover]:text-foreground [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-0.5',
        className
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 max-w-sm flex-col items-center gap-3 text-balance text-ui',
        className
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };

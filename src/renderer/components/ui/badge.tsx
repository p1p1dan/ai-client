import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-xs border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button,a&]:cursor-pointer [button,a&]:pointer-coarse:after:absolute [button,a&]:pointer-coarse:after:size-full [button,a&]:pointer-coarse:after:min-h-11 [button,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        // Design system v2: a tag is 12px (CJK floor), 4px radius, neutral or toned fill.
        default: 'h-5 min-w-5 px-1.5 text-small',
        lg: 'h-6 min-w-6 px-2 text-ui',
        sm: 'h-4.5 min-w-4.5 px-1 text-2xs',
      },
      variant: {
        // The four tinted variants below carry the status colour as *text* on a low-alpha
        // wash of the same hue. They must NOT use -foreground: since T-21 the Flexoki
        // status.*Foreground tokens are the on-solid-fill inks (near-white in light,
        // near-black in dark), so pairing them with a wash of their own hue collapsed to
        // 1.19:1 (light warning) and 1.39:1 (dark success). Same-hue text measures
        // 3.6:1-5.8:1 instead. -foreground stays reserved for solid fills (default,
        // destructive, secondary).
        default: 'bg-primary text-primary-foreground [button,a&]:hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground [button,a&]:hover:bg-destructive/90',
        error: 'bg-destructive/10 text-destructive dark:bg-destructive/16',
        info: 'bg-info/10 text-info dark:bg-info/16',
        outline:
          'border-border-soft bg-transparent text-muted-foreground [button,a&]:hover:bg-fill-ghost-hover',
        secondary: 'bg-fill-neutral text-muted-foreground [button,a&]:hover:bg-fill-ghost-selected',
        success: 'bg-success/10 text-success dark:bg-success/16',
        warning: 'bg-warning/10 text-warning dark:bg-warning/16',
      },
    },
  }
);

interface BadgeProps extends useRender.ComponentProps<'span'> {
  variant?: VariantProps<typeof badgeVariants>['variant'];
  size?: VariantProps<typeof badgeVariants>['size'];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    'data-slot': 'badge',
  };

  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };

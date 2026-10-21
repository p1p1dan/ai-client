import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // Design system v2 (docs/design-system.md §1, §4.1, §5): buttons are flat --
  // no shadow, no inner highlight, no squircle. Ghost is the default inside any
  // framed object (§1 rule 1): transparent, secondary ink, the one ghost-hover
  // fill on hover. Primary is clay. Radius `sm` (6px) on every size; the clamp
  // rule (§10.3) keeps the small sizes from turning into pills.
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent font-medium text-ui outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        none: '',
        default: 'h-8 px-3',
        icon: 'size-8',
        'icon-lg': 'size-9',
        'icon-sm': 'size-7',
        'icon-xl': "size-10 [&_svg:not([class*='size-'])]:size-5",
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 px-3.5',
        sm: 'h-7 gap-1 px-2.5',
        xl: "h-10 px-4 text-heading [&_svg:not([class*='size-'])]:size-5",
        xs: "h-6 gap-1 px-2 text-small [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 [:active,[data-pressed]]:bg-primary/85',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 [:active,[data-pressed]]:bg-destructive/85',
        'destructive-outline':
          'border-border-soft bg-transparent text-destructive [:hover,[data-pressed]]:border-destructive/30 [:hover,[data-pressed]]:bg-destructive/6',
        ghost:
          'bg-transparent text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground data-pressed:bg-fill-ghost-selected data-pressed:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        outline:
          'border-border-soft bg-transparent text-foreground [:hover,[data-pressed]]:border-border-strong [:hover,[data-pressed]]:bg-fill-ghost-hover',
        secondary:
          'bg-fill-neutral text-secondary-foreground hover:bg-fill-ghost-selected [:active,[data-pressed]]:bg-fill-ghost-selected',
      },
    },
  }
);

interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>['type'] = render
    ? undefined
    : 'button';

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    'data-slot': 'button',
    type: typeValue,
  };

  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants };

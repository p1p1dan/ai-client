'use client';

import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';

import { cn } from '@/lib/utils';

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, 'size'> & {
  size?: 'sm' | 'default' | 'lg' | number;
  unstyled?: boolean;
};

function Input({ className, size = 'default', unstyled = false, ...props }: InputProps) {
  return (
    <span
      className={
        cn(
          !unstyled &&
            // Design system v2: a framed control -- soft border, strong on hover,
            // clay ring on focus, no shadow.
            'relative inline-flex w-full rounded-sm border border-border-soft bg-surface-2 text-ui ring-ring/24 transition-[border-color,box-shadow] duration-150 hover:border-border-strong has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-50 has-focus-visible:ring-2',
          className
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      <InputPrimitive
        className={cn(
          'h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-foreground-faint sm:h-7.5 sm:leading-7.5',
          size === 'sm' &&
            'h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5',
          size === 'lg' && 'h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5',
          props.type === 'search' &&
            '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none',
          props.type === 'file' &&
            'text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm'
        )}
        data-slot="input"
        size={typeof size === 'number' ? size : undefined}
        {...props}
      />
    </span>
  );
}

export { Input, type InputProps };

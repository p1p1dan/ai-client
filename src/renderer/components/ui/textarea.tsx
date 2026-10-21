'use client';

import { Field as FieldPrimitive } from '@base-ui/react/field';
import { mergeProps } from '@base-ui/react/merge-props';
import type * as React from 'react';

import { cn } from '@/lib/utils';

type TextareaProps = React.ComponentProps<'textarea'> & {
  size?: 'sm' | 'default' | 'lg' | number;
  unstyled?: boolean;
  /** Rendered inside the control's wrapper, after the textarea (a layer laid over it). */
  overlay?: React.ReactNode;
};

function Textarea({
  className,
  size = 'default',
  unstyled = false,
  overlay,
  ...props
}: TextareaProps) {
  return (
    <span
      className={
        cn(
          !unstyled &&
            // Design system v2: same framed control as Input.
            'relative inline-flex w-full rounded-sm border border-border-soft bg-surface-2 text-ui ring-ring/24 transition-[border-color,box-shadow] duration-150 hover:border-border-strong has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-50 has-focus-visible:ring-2',
          className
        ) || undefined
      }
      data-size={size}
      data-slot="textarea-control"
    >
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            className={cn(
              'field-sizing-content min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5',
              size === 'sm' &&
                'min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5',
              size === 'lg' && 'min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5'
            )}
            data-slot="textarea"
            {...mergeProps(defaultProps, props)}
          />
        )}
      />
      {overlay}
    </span>
  );
}

export { Textarea, type TextareaProps };

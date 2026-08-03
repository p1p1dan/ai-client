import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * D25 §2.5 mono primitives -- the two building blocks for "content that is
 * mono" (paths / hashes / branch names inlined in prose / tool-row idents).
 * Both pin `font-mono` + `text-code` (13px, D25's optical-compensation value
 * against 15px sans body copy, see
 * docs/plans/2026-07-30-d25-font-domain-design.md §2.4) + `tracking-normal`
 * (mono + non-zero tracking breaks column alignment, D25 §3.3's tracking
 * ban on mono elements).
 *
 * `Ident` is the bare inline span; `CodeInline` adds the `<code>` chip
 * treatment for inline code spans in markdown/assistant prose (D25 §2.1 M2).
 */

function Ident({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('font-mono text-code tracking-normal', className)}
      data-slot="ident"
      {...props}
    />
  );
}

function CodeInline({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('rounded-xs bg-muted px-1 font-mono text-code tracking-normal', className)}
      data-slot="code-inline"
      {...props}
    />
  );
}

export { Ident, CodeInline };

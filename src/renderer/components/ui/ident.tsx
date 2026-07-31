import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * D25 §2.5 primitives — the sanctioned carriers of `font-mono` outside
 * code-block/mermaid. Inline machine text (paths, hashes, branch names in
 * prose, tool args) goes through these instead of scattering raw `font-mono`
 * utilities; the A1 guard (fontDomainGuards.test.ts) whitelists this file so
 * the optical-compensation pair (13px mono against 15px sans body) has one
 * adjustable home.
 *
 * `tracking-normal` is deliberate: mono + non-zero letter-spacing breaks
 * column alignment (D25 §3.3 ban, asserted by A5).
 */

/** Inline identifier: path / hash / branch-in-prose / session short code. */
export function Ident({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('font-mono text-code tracking-normal', className)}
      data-slot="ident"
      {...props}
    />
  );
}

/** Inline `<code>`-style chip: an Ident with the muted pill background. */
export function CodeInline({ className, ...props }: ComponentProps<'code'>) {
  return (
    <code
      className={cn('rounded-xs bg-muted px-1 font-mono text-code tracking-normal', className)}
      data-slot="code-inline"
      {...props}
    />
  );
}

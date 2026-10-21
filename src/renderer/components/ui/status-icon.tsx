import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Design system v2 §6: the one way to draw a run state. Tool rows, the turn
 * status line, the sub-agent and background-job windows, todos and the retry
 * banner all use this; none of them draws its own spinner or tick.
 *
 * Colours: running is neutral (never blue), waiting-on-you is the brand clay
 * breathing dot, success / failed are the semantic colours, stopped and idle
 * stay in the gray inks.
 */
export type RunStatus = 'running' | 'waiting' | 'success' | 'failed' | 'stopped' | 'idle';

interface StatusIconProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  status: RunStatus;
  /** Accessible name; omit when an adjacent label already says it. */
  label?: string;
}

function StatusIcon({ status, label, className, ...props }: StatusIconProps) {
  const glyph = (
    <>
      {status === 'running' && (
        <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
      )}
      {status === 'waiting' && (
        <span className="size-1.75 animate-breathe rounded-full bg-primary" />
      )}
      {status === 'success' && <CheckIcon className="size-3.5 text-success" />}
      {status === 'failed' && <XIcon className="size-3.5 text-destructive" />}
      {status === 'stopped' && (
        <span className="size-2 rounded-[2px] border-[1.5px] border-muted-foreground" />
      )}
      {status === 'idle' && (
        <span className="size-2.25 rounded-full border-[1.5px] border-foreground-faint" />
      )}
    </>
  );
  const slotClass = cn('inline-grid size-3.5 shrink-0 place-items-center', className);
  if (label) {
    return (
      <span
        aria-label={label}
        className={slotClass}
        data-slot="status-icon"
        data-status={status}
        role="img"
        {...props}
      >
        {glyph}
      </span>
    );
  }
  return (
    <span aria-hidden className={slotClass} data-slot="status-icon" data-status={status} {...props}>
      {glyph}
    </span>
  );
}

export { StatusIcon };

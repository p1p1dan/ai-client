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
  /**
   * Decision 208: `bullet` is the terminal transcript's `●`, coloured by the
   * same states. It takes the font and size of where it sits (the transcript's
   * bullet column) and is drawn as a pseudo-element, so it never reaches copied
   * or searched text. `star` is the CLI's working star (`✻`), cycling its
   * spinner glyphs while running — the terminal style's live line.
   */
  shape?: 'icon' | 'bullet' | 'star';
}

const BULLET_TONE: Record<RunStatus, string> = {
  // Neutral and blinking, as the CLI's dot for a call still in flight.
  running: 'text-foreground-faint animate-blink motion-reduce:animate-none',
  waiting: 'text-primary animate-breathe motion-reduce:animate-none',
  success: 'text-success',
  failed: 'text-destructive',
  stopped: 'text-foreground-faint',
  idle: 'text-foreground-faint',
};

const STAR_TONE: Record<RunStatus, string> = {
  // The brand ink, as the 「思考中 / 等你处理」 hint (design system v2 §1 rule 7).
  running: 'text-primary before:animate-star motion-reduce:before:animate-none',
  waiting: 'text-primary animate-breathe motion-reduce:animate-none',
  success: 'text-success',
  failed: 'text-destructive',
  stopped: 'text-foreground-faint',
  idle: 'text-foreground-faint',
};

function StatusIcon({ status, label, shape = 'icon', className, ...props }: StatusIconProps) {
  if (shape === 'bullet' || shape === 'star') {
    const bulletClass =
      shape === 'star'
        ? cn("before:content-['✻']", STAR_TONE[status], className)
        : cn("before:content-['●']", BULLET_TONE[status], className);
    if (label) {
      return (
        <span
          aria-label={label}
          className={bulletClass}
          data-shape={shape}
          data-slot="status-icon"
          data-status={status}
          role="img"
          {...props}
        />
      );
    }
    return (
      <span
        aria-hidden
        className={bulletClass}
        data-shape={shape}
        data-slot="status-icon"
        data-status={status}
        {...props}
      />
    );
  }
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

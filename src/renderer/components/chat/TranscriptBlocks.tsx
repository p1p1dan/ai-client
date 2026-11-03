import type { ChatTranscriptStyle } from '@shared/types/chatTranscriptStyle';
import { createContext, type ReactNode } from 'react';
import { type RunStatus, StatusIcon } from '@/components/ui/status-icon';
import { cn } from '@/lib/utils';
import { terminalBlockClass, terminalGutterClass } from './chatTimelineLayout';

/**
 * Decision 208: which transcript style the timeline draws. `MessageTimeline`
 * provides the reader's setting; with no provider (the subagent conversation
 * dialog, the side chat, a permission card's lone row, the rows inside an open
 * desktop run) a tool group draws today's rows.
 */
export const TranscriptStyleContext = createContext<ChatTranscriptStyle | null>(null);

/**
 * Decision 208 (user ruling 2026-11-03): inside the timeline a tool row leads
 * with the tool's own English name (`stepLabel`), never a translated verb —
 * also the rows a desktop run opens to and a settled permission card's row, so
 * one view never says `Bash` in one line and 「终端」 in the next. `false`
 * outside the timeline keeps today's words there.
 */
export const EnglishToolLabelsContext = createContext(false);

/**
 * Decision 208, desktop style: how a process section's runs start.
 *
 * - `forced`: open while a permission or question in the section waits on the
 *   reader — a closed run would hide the only way to answer (the T107 red line);
 * - `open`: the last section of a turn that ended abnormally starts open, so the
 *   output stays where it stopped (user rulings 2026-09-24 / 10-19); a click
 *   still closes it;
 * - `closed`: every other run.
 */
export type StepRunDisposition = 'forced' | 'open' | 'closed';

export const StepRunDispositionContext = createContext<StepRunDisposition>('closed');

/**
 * One block of the terminal style: the bullet column, then the content.
 *
 * `bullet`: `text` is the prose dot in the body ink, a `RunStatus` a step's
 * coloured dot, `thought` the CLI's dim `∴` before thinking, `null` an empty
 * column so the content still lines up with the text. The mark is a
 * pseudo-element in an `aria-hidden` column, so copying or searching the
 * transcript never picks it up.
 */
export function TerminalBlock({
  bullet,
  hideBullet = false,
  className,
  children,
}: {
  bullet: RunStatus | 'text' | 'thought' | null;
  /** Keeps the column but draws nothing, e.g. for prose that has not started yet. */
  hideBullet?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(terminalBlockClass(), className)} data-slot="terminal-block">
      <span aria-hidden className={terminalGutterClass()}>
        {bullet === 'thought' ? (
          <span
            data-slot="terminal-thought-mark"
            className={cn(
              "text-foreground-faint italic before:content-['∴']",
              hideBullet && 'invisible'
            )}
          />
        ) : bullet === null || bullet === 'text' ? (
          // A blank column still holds a glyph (invisible), so the block's
          // baseline is the first line's in every case.
          <span
            className={cn(
              "text-foreground before:content-['●']",
              (bullet === null || hideBullet) && 'invisible'
            )}
          />
        ) : (
          <StatusIcon shape="bullet" status={bullet} className={cn(hideBullet && 'invisible')} />
        )}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

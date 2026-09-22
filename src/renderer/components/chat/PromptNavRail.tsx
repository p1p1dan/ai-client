/**
 * Round-13 (user request 17, zcode parity): the floating prompt-history rail —
 * one small dash per historical USER input, pinned to the LEFT edge of the
 * chat content, hover shows the prompt, click scrolls to its turn.
 *
 * Mounting contract (matches the jump-to-bottom button, the established
 * "floating over the timeline but not scrolling with it" pattern):
 * it must be a child of MessageTimeline's `scrollRootRef` wrapper — the
 * `relative` div OUTSIDE the `ScrollArea`. In there it neither scrolls with
 * the content nor claims any of the reading column's 45rem/60rem width.
 *
 * Positioning is proportional (a minimap idiom, not a stacked list): dash N
 * of M sits at `N/(M-1)` of the rail's height, so the rail stays one glance
 * readable at any prompt count — a stacked list would overflow a short window
 * in a long session. Below 2 prompts there is nothing to navigate and the
 * rail renders nothing.
 */
import type { RefObject } from 'react';
import { useCallback } from 'react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';

export interface PromptNavItem {
  /** `Turn.id` — the user message's id, what `data-turn-id` anchors on. */
  id: string;
  /** The prompt's own text, blocks joined; empty only for attachments-only sends. */
  text: string;
}

interface PromptNavRailProps {
  prompts: readonly PromptNavItem[];
  /** MessageTimeline's `scrollRootRef`; the viewport is found through it. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function PromptNavRail({ prompts, containerRef }: PromptNavRailProps) {
  const { t } = useI18n();

  /**
   * Scrolls ONLY the timeline's own viewport, by explicit geometry —
   * `scrollIntoView` would also walk the outer `overflow-hidden` shell boxes,
   * which round-11 documented as "still a scroll container" and exactly the
   * sideways-scroll hazard that made the shell switch to `overflow-clip`.
   * A small negative offset keeps a sliver of the previous turn visible, so
   * the jump reads as "this question, in context" rather than a hard cut.
   */
  const jumpTo = useCallback(
    (id: string) => {
      const root = containerRef.current;
      if (!root) return;
      const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const target = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
      if (!viewport || !target) return;
      const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + delta - 12), behavior: 'smooth' });
    },
    [containerRef]
  );

  if (prompts.length < 2) return null;

  return (
    <nav aria-label={t('Prompt history')} className="absolute inset-y-4 left-1 z-10 w-3">
      {prompts.map((prompt, index) => (
        <Tooltip key={prompt.id}>
          <TooltipTrigger
            delay={200}
            render={
              <button
                type="button"
                // Spread across the rail's height (see the head note). The
                // hit area is taller than the dash itself so a 4px bar stays
                // clickable; dense sessions let neighbouring hit areas touch,
                // which degrades far more gracefully than a stacked list
                // overflowing the window.
                className="group absolute left-0 flex h-4 w-3 -translate-y-1/2 items-center justify-center"
                style={{ top: `${(index / (prompts.length - 1)) * 100}%` }}
                aria-label={`${t('Jump to this question')} #${index + 1}`}
                onClick={() => jumpTo(prompt.id)}
              />
            }
          >
            <span
              aria-hidden
              className="h-1 w-3 rounded-full bg-muted-foreground/35 transition-all group-hover:w-3.5 group-hover:bg-primary"
            />
          </TooltipTrigger>
          <TooltipPopup side="right" sideOffset={10} className="max-w-72">
            <p className="text-meta text-muted-foreground">#{index + 1}</p>
            <p className="line-clamp-4 break-words whitespace-pre-wrap text-ui">
              {/* An empty preview can only mean attachments carried the turn
                  (the composer refuses to send nothing), so that is the label. */}
              {prompt.text || t('Attachment only')}
            </p>
          </TooltipPopup>
        </Tooltip>
      ))}
    </nav>
  );
}

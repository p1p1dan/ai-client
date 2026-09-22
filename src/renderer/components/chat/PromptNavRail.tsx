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
 * Positioning is a centred cluster, NOT a spread (round-13 follow-up: the
 * first version distributed the dashes over the full timeline height and the
 * user rejected the gaps — 「隔得太远了，离近点集中点」). Every dash sits at
 * `DASH_PITCH` from its neighbour around the rail's midpoint, so the group
 * reads as one control instead of a scattered scale.
 *
 * The pitch is capped by `min()` against the rail's own height, which is what
 * keeps a long session from overflowing the window without any measurement:
 * once `DASH_PITCH * count` would exceed the rail, the cap takes over and the
 * cluster degrades into the proportional spread it replaced. Below 2 prompts
 * there is nothing to navigate and the rail renders nothing.
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

/**
 * Centre-to-centre distance between two dashes, in px. Round-13 second pass:
 * 8px (the tightest the tokens allow) clustered them into something the user
 * could not aim at — 「太近了都不好点」 — so the pitch is the 12px indent unit
 * instead. That is still one glance's worth of grouping, and it makes each hit
 * area 12px tall, three times the dash it covers.
 */
const DASH_PITCH = 12;

/**
 * `top` for dash `index` of `count`: the rail's midpoint, offset by whole
 * pitches. `min()` caps the pitch against the rail's own height (see the head
 * note), so the cluster can never grow past the window it floats in.
 */
function dashTop(index: number, count: number): string {
  const offset = index - (count - 1) / 2;
  const pitch = `min(${DASH_PITCH}px, 100% / ${count})`;
  if (offset === 0) return '50%';
  const sign = offset > 0 ? '+' : '-';
  return `calc(50% ${sign} ${Math.abs(offset)} * ${pitch})`;
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
    <nav aria-label={t('Prompt history')} className="absolute inset-y-4 left-1 z-10 w-4">
      {prompts.map((prompt, index) => (
        <Tooltip key={prompt.id}>
          <TooltipTrigger
            delay={200}
            render={
              <button
                type="button"
                // The hit area is exactly one pitch tall and the rail's full
                // width: neighbouring targets touch without overlapping, so a
                // 4px dash stays easy to aim at and no dash can steal the
                // hover of the one above it.
                className="group absolute left-0 flex h-3 w-4 -translate-y-1/2 items-center justify-center"
                style={{ top: dashTop(index, prompts.length) }}
                aria-label={`${t('Jump to this question')} #${index + 1}`}
                onClick={() => jumpTo(prompt.id)}
              />
            }
          >
            <span
              aria-hidden
              // Hover grows the dash on both axes (4→6px tall, 12→16px wide)
              // and takes it to the accent: at this pitch the pointer is the
              // only thing that says which prompt the tooltip belongs to, so
              // the focused dash has to be unmistakable, not merely tinted.
              className="h-1 w-3 rounded-full bg-muted-foreground/35 transition-all group-hover:h-1.5 group-hover:w-4 group-hover:bg-primary"
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

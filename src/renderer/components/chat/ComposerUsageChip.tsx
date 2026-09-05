/**
 * U09-2's reserved `usage` slot, filled by U06-b: how much of the model's
 * context window this conversation is currently occupying.
 *
 * ## Why a percentage and not a token count
 *
 * The composer bar is the one place a user looks WHILE composing, and the
 * decision it supports is "do I still have room, or should I start a new chat".
 * `68%` answers that in one glance; `136.2k` requires knowing the window by
 * heart. The exact numbers stay one click away in the Run surface, which is
 * where the rest of the usage breakdown already lives — so the tooltip here
 * carries them rather than the bar.
 *
 * ## When it renders nothing
 *
 * Whenever the runtime has not reported occupancy: no settled turn yet
 * (including a conversation just reopened), or a branch compacted with no reply
 * since — Pi returns `tokens: null` there and means it. The slot then collapses
 * to nothing at all rather than showing `0%` or a dash, per the same rule that
 * kept it empty while T38 was outstanding.
 *
 * Read-only, like `RunLocationIndicator` beside it: no hover background, no
 * chevron, default cursor. Nothing here is adjustable from the bar.
 */
import { deriveContextOccupancy } from '@shared/piUsage';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { formatTokenTotal } from './countFormat';

export function ComposerUsageChip({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const usage = useSessionRuntimeFactsStore(
    (state) => state.factsBySession[sessionId]?.usage ?? null
  );
  const occupancy = deriveContextOccupancy(usage?.context);
  if (!occupancy) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            // The visible glyph is only `68%`, which says nothing about what of.
            aria-label={t('Context used')}
            className="inline-flex h-6 shrink-0 cursor-default items-center whitespace-nowrap px-1.5 text-sm text-muted-foreground tabular-nums"
          />
        }
      >
        {`${Math.round(occupancy.percent)}%`}
      </TooltipTrigger>
      <TooltipPopup>
        {t('{{used}} of {{window}} context used', {
          used: formatTokenTotal(occupancy.usedTokens),
          window: formatTokenTotal(occupancy.contextWindow),
        })}
      </TooltipPopup>
    </Tooltip>
  );
}

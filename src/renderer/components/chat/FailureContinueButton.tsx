/**
 * T135 / decision 045 — the failure card's 「继续」: retry the last turn.
 *
 * Disabled until the failure has settled (the run's closing `idle` arrived)
 * and while a send for this session is still in flight; `blockedReason` says
 * which (`retryLastTurn.ts`).
 *
 * Decision 046 rule 4: a disabled control must not turn a click into another
 * action. A disabled `Button` is `pointer-events: none`, so a click lands on
 * whatever is under it; the wrapper swallows it and carries the tooltip the
 * disabled button itself can no longer show.
 */
import { Send } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

export interface FailureContinueButtonProps {
  /** Catalog key of the reason Continue is disabled; `null` when it is enabled. */
  blockedReason: string | null;
  onContinue: () => void;
}

function swallow(event: MouseEvent | KeyboardEvent): void {
  event.stopPropagation();
}

export function FailureContinueButton({ blockedReason, onContinue }: FailureContinueButtonProps) {
  const { t } = useI18n();
  const disabled = blockedReason !== null;
  const title = disabled ? t(blockedReason) : t('Retry the last turn from where it failed');
  return (
    <span
      className="mt-2 flex w-fit"
      data-testid="failure-continue"
      title={disabled ? title : undefined}
      onClick={swallow}
      onKeyDown={swallow}
    >
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-ui"
        disabled={disabled}
        title={title}
        onClick={() => {
          if (!disabled) onContinue();
        }}
      >
        <Send className="mr-1 h-3.5 w-3.5" />
        {t('Continue')}
      </Button>
    </span>
  );
}

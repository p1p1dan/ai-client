import { Monitor, Server } from 'lucide-react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';

interface RunLocationIndicatorProps {
  text: string;
  tone: 'local' | 'remote';
}

/**
 * Read-only: the run location is a repository property, not something the
 * Composer can change from here (T-27 decision #6 — a real dropdown is a
 * future D22 upgrade once remote target-switching exists). No chevron, no
 * hover background, default cursor — three cues that this is not a control.
 */
export function RunLocationIndicator({ text, tone }: RunLocationIndicatorProps) {
  const { t } = useI18n();
  const Icon = tone === 'remote' ? Server : Monitor;
  const label = t('Run location');

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            aria-label={label}
            // T-32 m8 (user round 2: 「this pc 还是存在换行的可能」): a short,
            // fixed label in an h-6 row must never be the thing that gives —
            // without `shrink-0` a long branch chip beside it squeezed this
            // one until its two words wrapped and the second was clipped by
            // the row height. The branch chip truncates instead (it has the
            // affordance for it: a tooltip and a popup carrying the full name).
            className="inline-flex h-6 shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap px-1.5 text-sm text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5 text-muted-foreground" />
        {text}
      </TooltipTrigger>
      <TooltipPopup className="max-w-66">
        {t(
          'Read-only indicator. The run location is derived from the repository: local shows This PC, remote shows the connection name; it is hidden entirely when unknown.'
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

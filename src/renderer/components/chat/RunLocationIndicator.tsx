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
            className="inline-flex h-6 cursor-default items-center gap-1.5 px-1.5 text-sm text-muted-foreground"
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

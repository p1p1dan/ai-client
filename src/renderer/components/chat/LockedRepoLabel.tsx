import { Folder, Lock } from 'lucide-react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { targetTriggerClass } from './middleColumnLayout';

interface LockedRepoLabelProps {
  label: string;
  path: string | null;
  reason: string;
}

/**
 * Session mode's first column: the repository this conversation is bound to,
 * shown as a locked LABEL rather than a control.
 *
 * Deliberately not a dropdown (T-28's `targetRowSlots('session')` dropped the
 * folder slot for the same reason). The binding is already made, and changing it
 * is not a re-point — it forks a new conversation, which the sidebar and the
 * empty-state card both offer. A dropdown here would promise an in-place switch
 * and deliver a different chat instead.
 *
 * Three cues say "not a control", matching `RunLocationIndicator`: no chevron
 * for a menu, no hover background, and the default cursor. The lock glyph and
 * its tooltip say WHY, because a disabled-looking chip with no explanation reads
 * as a bug.
 */
export function LockedRepoLabel({ label, path, reason }: LockedRepoLabelProps) {
  const { t } = useI18n();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="note"
            aria-label={`${t('Repository')}: ${label}`}
            className={`${targetTriggerClass('muted')} cursor-default whitespace-nowrap`}
          />
        }
      >
        <Folder className="size-3.5 shrink-0" />
        <span className="max-w-60 truncate">{label}</span>
        <Lock className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-80">
        <span className="block">{reason}</span>
        {path && <span className="mt-1 block font-mono text-code opacity-80">{path}</span>}
      </TooltipPopup>
    </Tooltip>
  );
}

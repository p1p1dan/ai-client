import { PanelRight } from 'lucide-react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { barIconClass } from '../SessionBar';
import type { SessionRailVisibility } from './sessionRailModel';

/** The toggle's words for each state; literal keys for the i18n coverage test. */
export function sessionRailToggleLabel(visibility: SessionRailVisibility): string {
  switch (visibility.hidden) {
    case null:
      return 'Hide session rail';
    case 'panes':
      return 'The session rail makes room while a pane is open';
    case 'narrow':
      return 'The window is too narrow for the session rail';
    default:
      return 'Show session rail';
  }
}

/**
 * Layout 5e: the title bar's session rail button (SessionBar's 5a slot,
 * leftmost in the right-hand group). Pressed while the rail is on screen.
 * While the panes or the width hide it, the button is disabled and says why —
 * a click there could change nothing on screen.
 */
export function SessionRailToggle({
  visibility,
  onToggle,
}: {
  visibility: SessionRailVisibility;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const label = t(sessionRailToggleLabel(visibility));
  const blocked = visibility.hidden === 'panes' || visibility.hidden === 'narrow';
  if (blocked) {
    // A disabled button gets no pointer events: the wrapper carries the reason.
    return (
      <span className="flex shrink-0" title={label}>
        <button
          type="button"
          disabled
          aria-pressed={false}
          aria-label={label}
          className="flex size-7 cursor-not-allowed items-center justify-center rounded-sm text-muted-foreground opacity-64"
          data-session-rail-toggle={visibility.hidden}
        >
          <PanelRight className="size-4" />
        </button>
      </span>
    );
  }
  const pressed = visibility.visible;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onToggle}
            className={barIconClass(pressed)}
            data-session-rail-toggle={pressed ? 'shown' : 'hidden'}
          />
        }
      >
        <PanelRight className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={6}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

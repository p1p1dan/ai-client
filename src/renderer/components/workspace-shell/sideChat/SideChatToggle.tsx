import { MessageCircle } from 'lucide-react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { barIconClass } from '../SessionBar';

/** The chord as the platform names it. */
export function sideChatShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘;' : 'Ctrl+;';
}

/**
 * Layout 5f (ruling L6): the title bar's side chat button, right of the
 * session rail's divider. Pressed while the side chat is open.
 */
export function SideChatToggle({
  open,
  onToggle,
  isMac,
}: {
  open: boolean;
  onToggle: () => void;
  isMac: boolean;
}) {
  const { t } = useI18n();
  const label = `${t('Side chat')} (${sideChatShortcutLabel(isMac)})`;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={open}
            onClick={onToggle}
            className={barIconClass(open)}
            data-side-chat-toggle={open ? 'open' : 'closed'}
          />
        }
      >
        <MessageCircle className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={6}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

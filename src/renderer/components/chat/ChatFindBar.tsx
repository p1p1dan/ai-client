/**
 * Chat search (stage 4, preview jump option 1): the find bar at the chat
 * area's top right — the query, which match of how many, previous / next
 * (wrapping) and close. It steps through the matches of the chat it floats
 * over; the timeline loads and reveals each one (`useChatJumpReveal`).
 *
 * Mounted inside `MessageTimeline`'s `relative` wrapper, outside the
 * ScrollArea, the same floating contract as `PromptNavRail`.
 */
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useChatJumpStore } from '@/stores/chatJump';

export function ChatFindBar({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const request = useChatJumpStore((state) =>
    state.request && state.request.sessionId === sessionId ? state.request : null
  );
  const step = useChatJumpStore((state) => state.step);
  const clear = useChatJumpStore((state) => state.clear);
  if (!request) return null;
  const count = request.messageKeys.length;

  return (
    <div
      role="search"
      aria-label={t('Find in chat')}
      data-chat-find-bar=""
      className="absolute top-2 right-4 z-10 flex h-8 max-w-80 items-center gap-1 rounded-md bg-popover ps-2.5 pe-1 text-popover-foreground elev-popover"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          clear();
        }
      }}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-small" title={request.query}>
        {request.query}
      </span>
      <span className="min-w-9 shrink-0 text-center text-2xs text-foreground-faint tabular-nums">
        {request.index + 1} / {count}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label={t('Previous match')}
        title={t('Previous match')}
        disabled={count < 2}
        onClick={() => step(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label={t('Next match')}
        title={t('Next match')}
        disabled={count < 2}
        onClick={() => step(1)}
      >
        <ChevronDown />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label={t('Close')}
        title={t('Close')}
        onClick={clear}
      >
        <X />
      </Button>
    </div>
  );
}

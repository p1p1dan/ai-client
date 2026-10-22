import { ArrowUp, PanelRight, PictureInPicture2, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { userBubbleClass, userBubbleRowClass } from '@/components/chat/chatTimelineLayout';
import { TurnTextItem } from '@/components/chat/MessageTimeline';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSideChatStore } from '@/stores/sideChat';
import { barIconClass } from '../SessionBar';
import {
  SIDE_CHAT_DOCK_WIDTH,
  SIDE_CHAT_FLOAT_HEIGHT,
  SIDE_CHAT_FLOAT_WIDTH,
  type SideChatEntry,
  sideChatBusy,
} from './sideChatModel';

function HeaderButton({
  label,
  onClick,
  children,
  data,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  data?: Record<string, string>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={barIconClass(false)}
            {...data}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={6}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

function EntryView({ entry, onRetry }: { entry: SideChatEntry; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2" data-side-chat-entry={entry.status}>
      <div className={userBubbleRowClass()}>
        <div className={cn(userBubbleClass(), 'whitespace-pre-wrap text-chat-body')}>
          {entry.question}
        </div>
      </div>
      {entry.status === 'pending' && (
        <div className="flex items-center gap-1.5 text-small text-muted-foreground">
          <Spinner className="size-3.5" aria-label={t('Answering…')} />
          {t('Answering…')}
        </div>
      )}
      {entry.status === 'answered' && entry.answer && (
        <div className="min-w-0 text-chat-body text-foreground">
          {/* The timeline's own prose renderer (as the subagent page uses). */}
          <TurnTextItem text={entry.answer} streaming={false} />
        </div>
      )}
      {entry.status === 'no-answer' && (
        <p className="text-small text-muted-foreground">
          {t('No answer this time. Try again, or ask in the conversation.')}
        </p>
      )}
      {entry.status === 'failed' && (
        <div className="flex items-center gap-2 text-small text-muted-foreground">
          <span className="min-w-0 flex-1">
            {t(entry.errorKey ?? 'The side question could not be answered. Try again.')}
          </span>
          <Button variant="ghost" size="xs" className="shrink-0" onClick={onRetry}>
            {t('Ask again')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Layout 5f (ui-cohesion §6, ruling L6): the side chat. A quick question about
 * the conversation on screen, answered here and never added to it; closing
 * discards it. `float`: a window over the chat's bottom-right corner (the
 * default, the reference's); `dock`: a column right of the chat, in the
 * session rail's place.
 *
 * Split view (ruling L7, another conversation in this container) is not here
 * yet: the title is plain text, not the reference's picker.
 */
export function SideChat({ placement }: { placement: 'float' | 'dock' }) {
  const { t } = useI18n();
  const sessionId = useSideChatStore((state) => state.sessionId);
  const entries = useSideChatStore((state) => state.entries);
  const busy = useSideChatStore(sideChatBusy);
  const close = useSideChatStore((state) => state.close);
  const setForm = useSideChatStore((state) => state.setForm);
  const ask = useSideChatStore((state) => state.ask);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A new side chat (opened, or reopened on another conversation) takes the keyboard.
  useEffect(() => {
    if (sessionId) inputRef.current?.focus();
  }, [sessionId]);

  // The newest question and its answer stay in view.
  const lastEntry = entries[entries.length - 1];
  const lastKey = lastEntry ? `${lastEntry.id}:${lastEntry.status}` : '';
  useEffect(() => {
    if (!lastKey) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lastKey]);

  if (!sessionId) return null;

  const submit = () => {
    const question = draft.trim();
    if (!question || busy) return;
    if (ask(sessionId, question)) setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const docked = placement === 'dock';
  return (
    <section
      aria-label={t('Side chat')}
      data-side-chat={placement}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          close();
        }
      }}
      className={cn(
        'flex min-h-0 flex-col',
        docked
          ? 'shrink-0 border-border-soft border-l bg-surface-1'
          : 'absolute right-4 bottom-4 z-20 max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] rounded-2xl bg-surface-3 elev-popover'
      )}
      style={
        docked
          ? { width: SIDE_CHAT_DOCK_WIDTH }
          : { width: SIDE_CHAT_FLOAT_WIDTH, height: SIDE_CHAT_FLOAT_HEIGHT }
      }
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-border-soft border-b pr-2 pl-3.5">
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{t('Side chat')}</span>
        {docked ? (
          <HeaderButton
            label={t('Float as a window')}
            onClick={() => setForm('float')}
            data={{ 'data-side-chat-form': 'float' }}
          >
            <PictureInPicture2 className="size-4" />
          </HeaderButton>
        ) : (
          <HeaderButton
            label={t('Dock to the right')}
            onClick={() => setForm('dock')}
            data={{ 'data-side-chat-form': 'dock' }}
          >
            <PanelRight className="size-4" />
          </HeaderButton>
        )}
        <HeaderButton
          label={t('Close side chat')}
          onClick={close}
          data={{ 'data-side-chat-close': '' }}
        >
          <X className="size-4" />
        </HeaderButton>
      </header>
      <p className="shrink-0 px-3.5 pt-2 text-small text-foreground-faint">
        {t(
          'It can read this conversation up to now. Nothing here is added to it, and closing discards it.'
        )}
      </p>
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-2.5"
      >
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} onRetry={() => ask(sessionId, entry.question)} />
        ))}
      </div>
      <div className="mx-2.5 mb-2.5 flex shrink-0 items-end gap-1.5 rounded-lg border border-border-soft bg-surface-2 py-1.5 pr-1.5 pl-3">
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('Ask a side question without interrupting…')}
          aria-label={t('Ask a question')}
          className="field-sizing-content max-h-32 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0.5 text-chat-body text-foreground outline-none placeholder:text-foreground-faint"
          data-side-chat-input=""
        />
        <Button
          size="icon-xs"
          className="shrink-0 rounded-full"
          disabled={busy || !draft.trim()}
          aria-label={t('Ask a question')}
          onClick={submit}
          data-side-chat-send=""
        >
          <ArrowUp />
        </Button>
      </div>
    </section>
  );
}

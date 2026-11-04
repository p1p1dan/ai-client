import { ArrowUp, PanelRight, PictureInPicture2, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { userBubbleClass, userBubbleRowClass } from '@/components/chat/chatTimelineLayout';
import { TurnTextItem } from '@/components/chat/MessageTimeline';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSideChatStore } from '@/stores/sideChat';
import { barIconClass } from '../SessionBar';
import { SIDE_CHAT_DOCK_WIDTH, type SideChatEntry, sideChatBusy } from './sideChatModel';

function HeaderButton({
  label,
  onClick,
  children,
  data,
  nativeTitle = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  data?: Record<string, string>;
  /**
   * Decision 209 §3: in the side chat's own window a tooltip would be drawn
   * into the MAIN window (its portal's document), so the button says its
   * name the native way there.
   */
  nativeTitle?: boolean;
}) {
  if (nativeTitle) {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        className={barIconClass(false)}
        {...data}
      >
        {children}
      </button>
    );
  }
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
 * a conversation, answered here and never added to it; closing discards it.
 * Decision 209 §3 forms: `window`, a window of its own (the default; drawn
 * into by `SideChatWindow`); `dock`, a column right of the chat, in the
 * session rail's place; `dock-over`, that column lying over the chat's right
 * edge while the chat is too narrow to keep it beside it.
 *
 * It stays on the conversation it was opened on (ruling 4): the title names
 * it, and a note says so while the main window shows another one.
 *
 * `overDrawer`: lying over the chat while the panes cover it as a drawer too
 * (a narrow window); the side chat goes on top, else it would vanish under it.
 */
export function SideChat({
  placement,
  overDrawer = false,
}: {
  placement: 'window' | 'dock' | 'dock-over';
  overDrawer?: boolean;
}) {
  const { t } = useI18n();
  const sessionId = useSideChatStore((state) => state.sessionId);
  const entries = useSideChatStore((state) => state.entries);
  const busy = useSideChatStore(sideChatBusy);
  const close = useSideChatStore((state) => state.close);
  const setForm = useSideChatStore((state) => state.setForm);
  const ask = useSideChatStore((state) => state.ask);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessionTitle = useChatSessionsStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.title ?? null
  );
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inWindow = placement === 'window';

  // A new side chat (opened, or moved to another conversation) takes the
  // keyboard — in its own window, that window first.
  useEffect(() => {
    if (!sessionId) return;
    const input = inputRef.current;
    if (inWindow) input?.ownerDocument.defaultView?.focus();
    input?.focus();
  }, [sessionId, inWindow]);

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

  const conversation = sessionTitle === null ? null : displaySessionTitle(sessionTitle, t);
  // Ruling 4: it reads its own conversation, which may not be the one on screen.
  const elsewhere = sessionId !== activeSessionId;
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
        'flex min-h-0 flex-col bg-surface-1',
        inWindow && 'h-full border border-border-soft',
        placement === 'dock' && 'shrink-0 border-border-soft border-l',
        placement === 'dock-over' &&
          'absolute inset-y-0 right-0 border-border-soft border-l elev-lg',
        // The drawer (PaneArea) is `z-20` and later in the row.
        placement === 'dock-over' && (overDrawer ? 'z-30' : 'z-20')
      )}
      style={inWindow ? undefined : { width: SIDE_CHAT_DOCK_WIDTH }}
    >
      <header
        className={cn(
          'flex h-10 shrink-0 items-center gap-1 border-border-soft border-b pr-2 pl-3.5',
          // Frameless: the header is what the window is dragged by.
          inWindow && 'drag-region select-none'
        )}
      >
        <span className="min-w-0 flex-1 truncate text-ui text-foreground" data-side-chat-title="">
          {conversation ? `${t('Side chat')} · ${conversation}` : t('Side chat')}
        </span>
        {inWindow ? (
          <HeaderButton
            label={t('Dock to the main window')}
            onClick={() => setForm('dock')}
            data={{ 'data-side-chat-form': 'dock' }}
            nativeTitle
          >
            <PanelRight className="size-4" />
          </HeaderButton>
        ) : (
          <HeaderButton
            label={t('Pop out as a window')}
            onClick={() => setForm('window')}
            data={{ 'data-side-chat-form': 'window' }}
          >
            <PictureInPicture2 className="size-4" />
          </HeaderButton>
        )}
        <HeaderButton
          label={t('Close side chat')}
          onClick={close}
          data={{ 'data-side-chat-close': '' }}
          nativeTitle={inWindow}
        >
          <X className="size-4" />
        </HeaderButton>
      </header>
      <p className="shrink-0 px-3.5 pt-2 text-small text-foreground-faint">
        {t(
          'It can read this conversation up to now. Nothing here is added to it, and closing discards it.'
        )}
      </p>
      {elsewhere && conversation && (
        <p
          className="shrink-0 px-3.5 pt-1 text-small text-foreground-faint"
          data-side-chat-elsewhere=""
        >
          {t('It reads “{{title}}”, not the conversation open in the main window.', {
            title: conversation,
          })}
        </p>
      )}
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

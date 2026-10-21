/**
 * Decision 203: a subagent's own conversation, read-only — its sub-conversation
 * page, opened from the subagents window. It reads the child's whole
 * transcript from the engine (`chat:subagentHistory`: DSH's child session log,
 * or the CLI's `subagents/agent-<id>.jsonl`), not the lane under the
 * delegating row, which keeps a clamped tail. A running child is read again
 * every few seconds while the page is open.
 *
 * Drawn with the timeline's own pieces (`TurnTextItem` for prose, `ToolGroup` for
 * calls and thoughts) but with no session behind them: no expand memory, no
 * per-row controls, nothing to answer.
 */

import type { WorkerSubagentHistoryResult } from '@shared/types/workerRpc';
import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import { mapHistoryMessageToChatMessage } from '@/stores/chatSessions';
import { userBubbleClass, userBubbleRowClass, userBubbleTextClass } from './chatTimelineLayout';
import { TurnTextItem } from './MessageTimeline';
import { ToolGroup } from './ToolRows';
import { deriveToolGroupRows, groupTimeline } from './toolCard';

/** How often a running child's page is read again. */
export const SUBAGENT_CONVERSATION_REFRESH_MS = 3_000;

export function SubagentConversationDialog({
  sessionId,
  childId,
  title,
  running,
  onClose,
}: {
  sessionId: string;
  childId: string;
  title: string;
  running: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [history, setHistory] = useState<WorkerSubagentHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.chat.subagentHistory({ sessionId, childId });
        if (!cancelled) {
          setHistory(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(unwrapIpcErrorMessage(caught));
      }
    };
    void read();
    const timer = running
      ? window.setInterval(() => void read(), SUBAGENT_CONVERSATION_REFRESH_MS)
      : 0;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [sessionId, childId, running]);

  const messages = useMemo(
    () =>
      (history?.messages ?? []).map((message) =>
        mapHistoryMessageToChatMessage(`subagent:${childId}`, message)
      ),
    [history, childId]
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>
            {running ? t('Subagent conversation · running') : t('Subagent conversation')}
          </DialogDescription>
        </DialogHeader>
        {/* Not `DialogPanel`: its ScrollArea grows to fill the popup with no way
            to cap it, so the cap and the px-6 padding are applied by hand, as
            AnnouncementDialog does. */}
        <ScrollArea className="max-h-[70vh] px-6 pb-6">
          <div className="flex flex-col gap-3 pr-3" data-testid="subagent-conversation">
            {error && (
              <Alert variant="error">
                <CircleAlertIcon />
                <AlertDescription className="select-text">{error}</AlertDescription>
              </Alert>
            )}
            {history?.truncated && (
              <p className="text-small text-muted-foreground">
                {t('Earlier messages are left out')}
              </p>
            )}
            {history && messages.length === 0 && !error && (
              <p className="text-small text-muted-foreground">{t('Nothing recorded yet')}</p>
            )}
            {messages.map((message) =>
              message.role === 'user' ? (
                // Design system v2 §7.1: the timeline's own user message, from
                // the same style functions, so the two never drift apart.
                <div key={message.id} className={userBubbleRowClass()}>
                  <div className={userBubbleClass()}>
                    <div className={userBubbleTextClass()}>
                      <p className="whitespace-pre-wrap break-words text-chat-body">
                        {message.blocks
                          .map((block) => (block.type === 'text' ? block.text : ''))
                          .filter(Boolean)
                          .join('\n')}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div key={message.id} className="flex min-w-0 flex-col gap-2">
                  {groupTimeline(message).map((item) => {
                    if (item.kind === 'text' && item.block.text) {
                      return (
                        <TurnTextItem
                          key={`${message.id}-${item.blockIndex}`}
                          text={item.block.text}
                          streaming={false}
                        />
                      );
                    }
                    if (item.kind === 'toolGroup') {
                      return (
                        <ToolGroup
                          key={`${message.id}-${item.blockIndex}`}
                          rows={deriveToolGroupRows(item.entries, { t })}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              )
            )}
          </div>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
}

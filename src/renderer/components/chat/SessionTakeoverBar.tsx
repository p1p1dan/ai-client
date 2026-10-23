/**
 * The composer's place while a plugin's client (the remote web page) controls
 * the session (plugin-system README §4, preview option A, user 2026-10-23):
 * one bar that says where it is in use, Stop, and Take over. The desktop keeps
 * watching; it changes nothing until it takes the session back.
 */

import { Hand, Smartphone, Square } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { stopChatSession } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { takeOverSession, useRemoteController } from '@/stores/sessionControl';
import { composerCardClass } from './middleColumnLayout';
import { ReadingColumn } from './ReadingColumn';
import { isSessionBusy } from './sessionIndex/resumeIntent';

export function SessionTakeoverBar({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [taking, setTaking] = useState(false);
  const controller = useRemoteController(sessionId);
  const status = useChatSessionsStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.status ?? 'idle'
  );
  if (!sessionId || !controller) return null;
  const { label } = controller;
  // A turn is running: Stop is offered (either side may stop).
  const busy = isSessionBusy(status);
  return (
    <ReadingColumn>
      <div
        className={cn(
          composerCardClass('session'),
          'flex-row items-center gap-2 py-1.5 pr-1.5 pl-3'
        )}
        data-testid="session-takeover-bar"
      >
        <Smartphone className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          {t('In use on {{label}}; you can only watch here', { label })}
        </span>
        {busy && (
          <Button variant="ghost" size="sm" onClick={() => void stopChatSession(sessionId)}>
            <Square />
            {t('Stop')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={taking}
          onClick={() => {
            setTaking(true);
            takeOverSession(sessionId)
              .catch((error: unknown) => console.warn('[sessionControl] take over failed:', error))
              .finally(() => setTaking(false));
          }}
        >
          <Hand />
          {t('Take over')}
        </Button>
      </div>
    </ReadingColumn>
  );
}

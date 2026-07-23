import { SendHorizonal, Square } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useChatSessionsStore } from '@/stores/chatSessions';

interface ChatComposerProps {
  disabled?: boolean;
}

function isStoppable(status: string | undefined): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'waiting_question'
  );
}

export function ChatComposer({ disabled }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const sendMessage = useChatSessionsStore((state) => state.sendMessage);
  const stopActiveSession = useChatSessionsStore((state) => state.stopActiveSession);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const lastError = useChatSessionsStore((state) => state.lastError);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const busy = isStoppable(activeSession?.status);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || busy) {
      return;
    }
    void sendMessage(trimmed);
    setValue('');
  };

  return (
    <div className="shrink-0 border-t bg-background/80 p-3">
      <div className="rounded-lg border bg-card/40 p-2">
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Message Claude via Agent Host…"
          className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={disabled || busy}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {lastError
              ? `Error: ${lastError}`
              : busy
                ? 'Agent Host running — use Stop to abort'
                : 'Agent SDK Host · Send / Stop · Permission 卡可 Allow/Deny'}
          </p>
          <div className="flex shrink-0 gap-1">
            {busy ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6"
                disabled={disabled}
                onClick={() => void stopActiveSession()}
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-6"
                disabled={disabled || !value.trim()}
                onClick={handleSend}
              >
                <SendHorizonal className="h-3.5 w-3.5" />
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

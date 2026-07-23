import { SendHorizonal } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useChatSessionsStore } from '@/stores/chatSessions';

interface ChatComposerProps {
  disabled?: boolean;
}

export function ChatComposer({ disabled }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const sendMessage = useChatSessionsStore((state) => state.sendMessage);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }
    sendMessage(trimmed);
    setValue('');
  };

  return (
    <div className="shrink-0 border-t bg-background/80 p-3">
      <div className="rounded-lg border bg-card/40 p-2">
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="@files /commands !shell — mock composer"
          className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Mock runtime: idle → running → text → tool → permission → completed
          </p>
          <Button
            size="sm"
            className="h-6"
            disabled={disabled || !value.trim()}
            onClick={handleSend}
          >
            <SendHorizonal className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

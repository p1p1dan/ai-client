/**
 * Streaming indicator bubble shown while the assistant is generating a response.
 * Displays a blinking cursor to indicate active generation.
 */

import { memo } from 'react';
import { cn } from '@/lib/utils';

interface StreamingBubbleProps {
  className?: string;
}

export const StreamingBubble = memo(function StreamingBubble({ className }: StreamingBubbleProps) {
  return (
    <div className={cn('flex justify-start mb-4 px-4', className)}>
      <div className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/60 animate-pulse" />
        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:150ms]" />
        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/20 animate-pulse [animation-delay:300ms]" />
      </div>
    </div>
  );
});

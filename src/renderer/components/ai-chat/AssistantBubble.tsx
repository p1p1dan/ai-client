/**
 * Assistant message bubble for the Cursor-style chat UI.
 * Left-aligned, no background, renders markdown content.
 */

import { memo } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AssistantBubbleProps {
  content: string;
  className?: string;
}

export const AssistantBubble = memo(function AssistantBubble({
  content,
  className,
}: AssistantBubbleProps) {
  return (
    <div className={cn('flex justify-start mb-4 px-4', className)}>
      <div className="max-w-[85%] min-w-0">
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
});

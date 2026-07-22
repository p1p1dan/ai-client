/**
 * User message bubble for the Cursor-style chat UI.
 * Right-aligned with a subtle primary-tinted background.
 */

import { cn } from '@/lib/utils';

interface UserBubbleProps {
  text: string;
  imagePaths?: string[];
  className?: string;
}

export function UserBubble({ text, imagePaths = [], className }: UserBubbleProps) {
  return (
    <div className={cn('flex justify-end mb-3 px-4', className)}>
      <div className="max-w-[75%] rounded-md bg-primary/15 border border-primary/30 px-3.5 py-2.5">
        <p className="text-sm text-foreground whitespace-pre-wrap">{text}</p>
        {imagePaths.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {imagePaths.map((path) => (
              <div
                key={path}
                className="relative h-16 w-16 overflow-hidden rounded border border-border"
              >
                <img
                  src={`file://${path}`}
                  alt={path.split(/[\\/]/).pop() ?? path}
                  className="h-full w-full object-cover"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Bash tool view: displays the command and its terminal-style output.
 */

import { cn } from '@/lib/utils';
import type { ToolViewProps } from '../ToolCallCard';

export function BashToolView({ input, result, status, isError }: ToolViewProps) {
  const command = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).command
    : undefined;

  return (
    <div className="text-xs">
      <div className="mb-2 rounded bg-muted/80 px-2 py-1.5 font-mono text-foreground">
        <span className="text-muted-foreground">$ </span>
        {typeof command === 'string' ? command : 'unknown command'}
      </div>
      {status === 'done' && result && (
        <pre
          className={cn(
            'max-h-60 overflow-y-auto rounded bg-muted/50 p-2 font-mono whitespace-pre-wrap',
            isError ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {result}
        </pre>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Running...</div>
      )}
      {status === 'error' && result && (
        <pre className="max-h-60 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-destructive whitespace-pre-wrap">
          {result}
        </pre>
      )}
    </div>
  );
}

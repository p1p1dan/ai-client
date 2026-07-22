/**
 * Generic fallback tool view for tools without a specialized view.
 */

import type { ToolViewProps } from '../ToolCallCard';

export function GenericToolView({ input, result, status }: ToolViewProps) {
  return (
    <div className="text-xs">
      <div className="mb-2 font-mono text-muted-foreground">
        {JSON.stringify(input, null, 2)}
      </div>
      {status === 'done' && result && (
        <pre className="max-h-40 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-muted-foreground whitespace-pre-wrap">
          {result}
        </pre>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Running...</div>
      )}
    </div>
  );
}

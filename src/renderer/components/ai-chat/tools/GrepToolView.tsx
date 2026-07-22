/**
 * Grep tool view: displays the search pattern and matching lines.
 */

import { useNavigationStore } from '@/stores/navigation';
import type { ToolViewProps } from '../ToolCallCard';

export function GrepToolView({ input, result, status }: ToolViewProps) {
  const navigateToFile = useNavigationStore((s) => s.navigateToFile);
  const pattern = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).pattern
    : undefined;

  const lines = result
    ? result.split('\n').filter((line) => line.trim().length > 0)
    : [];

  return (
    <div className="text-xs">
      <div className="mb-2">
        <span className="font-mono text-muted-foreground">{typeof pattern === 'string' ? pattern : ''}</span>
        <span className="ml-2 text-muted-foreground">({lines.length} matches)</span>
      </div>
      {status === 'done' && lines.length > 0 && (
        <div className="max-h-40 overflow-y-auto space-y-0.5">
          {lines.slice(0, 50).map((line) => {
            // ripgrep format: file:line:content or file:line-content
            const match = line.match(/^([^:]+):(\d+)[:.](.*)$/);
            if (match) {
              const [, file, lineNum] = match;
              return (
                <button
                  key={line}
                  type="button"
                  onClick={() => navigateToFile({ path: file, line: Number(lineNum) })}
                  className="block w-full text-left font-mono text-primary hover:underline truncate"
                >
                  {line}
                </button>
              );
            }
            return (
              <div key={line} className="font-mono text-muted-foreground truncate">
                {line}
              </div>
            );
          })}
          {lines.length > 50 && (
            <div className="text-muted-foreground">... and {lines.length - 50} more</div>
          )}
        </div>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Searching...</div>
      )}
    </div>
  );
}

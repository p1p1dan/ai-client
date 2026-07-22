/**
 * Glob tool view: displays the glob pattern and matching files.
 */

import { useNavigationStore } from '@/stores/navigation';
import type { ToolViewProps } from '../ToolCallCard';

export function GlobToolView({ input, result, status }: ToolViewProps) {
  const navigateToFile = useNavigationStore((s) => s.navigateToFile);
  const pattern = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).pattern
    : undefined;

  const files = result
    ? result.split('\n').filter((line) => line.trim().length > 0)
    : [];

  return (
    <div className="text-xs">
      <div className="mb-2">
        <span className="font-mono text-muted-foreground">{typeof pattern === 'string' ? pattern : ''}</span>
        <span className="ml-2 text-muted-foreground">({files.length} files)</span>
      </div>
      {status === 'done' && files.length > 0 && (
        <div className="max-h-40 overflow-y-auto space-y-0.5">
          {files.slice(0, 50).map((file) => (
            <button
              key={file}
              type="button"
              onClick={() => navigateToFile({ path: file })}
              className="block w-full text-left font-mono text-primary hover:underline truncate"
            >
              {file}
            </button>
          ))}
          {files.length > 50 && (
            <div className="text-muted-foreground">... and {files.length - 50} more</div>
          )}
        </div>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Searching...</div>
      )}
    </div>
  );
}

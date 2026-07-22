/**
 * Read tool view: displays file path and a preview of the file content.
 */

import { useNavigationStore } from '@/stores/navigation';
import type { ToolViewProps } from '../ToolCallCard';

export function ReadToolView({ input, result, status }: ToolViewProps) {
  const navigateToFile = useNavigationStore((s) => s.navigateToFile);
  const filePath = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).file_path
    : undefined;
  const offset = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).offset
    : undefined;
  const limit = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).limit
    : undefined;

  const handleOpenFile = () => {
    if (typeof filePath === 'string') {
      navigateToFile({ path: filePath, line: typeof offset === 'number' ? offset : undefined });
    }
  };

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleOpenFile}
          className="font-mono text-primary hover:underline"
        >
          {typeof filePath === 'string' ? filePath : 'unknown file'}
        </button>
        {typeof offset === 'number' && (
          <span className="text-muted-foreground">
            from line {offset}
            {typeof limit === 'number' ? `, ${limit} lines` : ''}
          </span>
        )}
      </div>
      {status === 'done' && result && (
        <pre className="max-h-60 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-muted-foreground whitespace-pre-wrap">
          {result.length > 2000 ? `${result.slice(0, 2000)}\n... (truncated)` : result}
        </pre>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Reading file...</div>
      )}
    </div>
  );
}

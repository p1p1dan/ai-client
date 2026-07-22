/**
 * Write tool view: displays file path and a diff preview of the content being written.
 */

import { useNavigationStore } from '@/stores/navigation';
import type { ToolViewProps } from '../ToolCallCard';

export function WriteToolView({ input, result, status }: ToolViewProps) {
  const navigateToFile = useNavigationStore((s) => s.navigateToFile);
  const filePath = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).file_path
    : undefined;

  const handleOpenFile = () => {
    if (typeof filePath === 'string') {
      navigateToFile({ path: filePath });
    }
  };

  return (
    <div className="text-xs">
      <div className="mb-2">
        <button
          type="button"
          onClick={handleOpenFile}
          className="font-mono text-primary hover:underline"
        >
          {typeof filePath === 'string' ? filePath : 'unknown file'}
        </button>
      </div>
      {status === 'done' && (
        <div className="text-success">File written successfully</div>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Writing file...</div>
      )}
      {status === 'error' && result && (
        <div className="text-destructive">{result}</div>
      )}
    </div>
  );
}

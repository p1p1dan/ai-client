/**
 * Edit tool view: displays file path and a diff preview of the edit.
 */

import { useNavigationStore } from '@/stores/navigation';
import type { ToolViewProps } from '../ToolCallCard';

export function EditToolView({ input, result, status }: ToolViewProps) {
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
        <div className="text-success">Edit applied successfully</div>
      )}
      {status === 'running' && (
        <div className="text-muted-foreground">Applying edit...</div>
      )}
      {status === 'error' && result && (
        <div className="text-destructive">{result}</div>
      )}
    </div>
  );
}

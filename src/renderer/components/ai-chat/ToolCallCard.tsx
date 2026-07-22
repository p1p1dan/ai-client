/**
 * Tool call card for the Cursor-style chat UI.
 * Displays a tool invocation as a collapsible card with a header showing
 * tool name, status, and summary; expanding reveals tool-specific details.
 */

import { ChevronDown, Edit3, FileText, Search, Terminal } from 'lucide-react';
import { memo, useState } from 'react';
import { cn } from '@/lib/utils';
import { BashToolView } from './tools/BashToolView';
import { EditToolView } from './tools/EditToolView';
import { GenericToolView } from './tools/GenericToolView';
import { GlobToolView } from './tools/GlobToolView';
import { GrepToolView } from './tools/GrepToolView';
import { ReadToolView } from './tools/ReadToolView';
import { WriteToolView } from './tools/WriteToolView';

const TOOL_ICONS: Record<string, typeof FileText> = {
  Read: FileText,
  Write: Edit3,
  Edit: Edit3,
  Bash: Terminal,
  Glob: Search,
  Grep: Search,
};

const TOOL_VIEW_MAP: Record<string, React.ComponentType<ToolViewProps>> = {
  Read: ReadToolView,
  Write: WriteToolView,
  Edit: EditToolView,
  Bash: BashToolView,
  Glob: GlobToolView,
  Grep: GrepToolView,
};

export interface ToolViewProps {
  input: unknown;
  result?: string;
  status: 'streaming' | 'running' | 'done' | 'error';
  isError?: boolean;
}

interface ToolCallCardProps {
  toolName: string;
  toolUseId: string;
  input: unknown;
  status: 'streaming' | 'running' | 'done' | 'error';
  result?: string;
  isError?: boolean;
  className?: string;
}

function StatusBadge({ status, isError }: { status: string; isError?: boolean }) {
  if (isError) {
    return <span className="text-xs text-destructive">✕</span>;
  }
  if (status === 'running' || status === 'streaming') {
    return <span className="text-xs text-info">●</span>;
  }
  return <span className="text-xs text-success">✓</span>;
}

function getToolSummary(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case 'Read':
      return typeof obj.file_path === 'string' ? obj.file_path : '';
    case 'Write':
      return typeof obj.file_path === 'string' ? obj.file_path : '';
    case 'Edit':
      return typeof obj.file_path === 'string' ? obj.file_path : '';
    case 'Bash':
      return typeof obj.command === 'string' ? obj.command : '';
    case 'Glob':
      return typeof obj.pattern === 'string' ? obj.pattern : '';
    case 'Grep':
      return typeof obj.pattern === 'string' ? obj.pattern : '';
    default:
      return '';
  }
}

export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  toolUseId: _toolUseId,
  input,
  status,
  result,
  isError,
  className,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(status === 'running');
  const Icon = TOOL_ICONS[toolName] ?? FileText;
  const ToolView = TOOL_VIEW_MAP[toolName] ?? GenericToolView;
  const summary = getToolSummary(toolName, input);

  return (
    <div className={cn('mx-4 mb-2 rounded-md border border-border bg-card/50', className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground shrink-0">{toolName}</span>
        {summary && (
          <span className="text-xs text-muted-foreground truncate min-w-0">{summary}</span>
        )}
        <StatusBadge status={status} isError={isError} />
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {expanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <ToolView input={input} result={result} status={status} isError={isError} />
        </div>
      )}
    </div>
  );
});

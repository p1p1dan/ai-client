/**
 * Project list panel for the Cursor-style layout.
 * Replaces the legacy RepositorySidebar + TreeSidebar + WorktreePanel three-column layout
 * with a single flat list where each worktree is treated as a "project".
 */

import { Folder, Plus } from 'lucide-react';
import { memo, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { GitWorktree } from '@shared/types';

interface ProjectEntry {
  worktreePath: string;
  repoPath: string;
  name: string;
  branch?: string;
  isMainWorktree: boolean;
  lastActivityAt: number;
  unreadCount: number;
}

interface ProjectListPanelProps {
  /** Flat list of worktrees to display as projects. */
  projects: ProjectEntry[];
  /** Currently selected project (worktree path). */
  activeProjectPath?: string;
  /** Called when a project is clicked. */
  onSelectProject: (worktreePath: string) => void;
  /** Called when the "Add project" button is clicked. */
  onAddProject: () => void;
  className?: string;
}

export const ProjectListPanel = memo(function ProjectListPanel({
  projects,
  activeProjectPath,
  onSelectProject,
  onAddProject,
  className,
}: ProjectListPanelProps) {
  const handleSelect = useCallback(
    (path: string) => {
      onSelectProject(path);
    },
    [onSelectProject]
  );

  return (
    <div className={cn('w-60 border-r border-border bg-background flex flex-col', className)}>
      <div className="h-9 flex items-center px-3 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-muted-foreground">Projects</span>
        <button
          type="button"
          onClick={onAddProject}
          className="ml-auto h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Add project"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {projects.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              No projects yet
            </div>
          )}
          {projects.map((project) => (
            <button
              key={project.worktreePath}
              type="button"
              onClick={() => handleSelect(project.worktreePath)}
              className={cn(
                'w-full text-left px-3 py-2 transition-colors flex items-center gap-2',
                project.worktreePath === activeProjectPath
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              )}
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{project.name}</div>
                {project.branch && (
                  <div className="text-xs text-muted-foreground truncate">{project.branch}</div>
                )}
              </div>
              {project.unreadCount > 0 && (
                <span className="shrink-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                  {project.unreadCount > 99 ? '99+' : project.unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
});

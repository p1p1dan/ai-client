import { type Ref, useMemo, useState } from 'react';
import type { Repository } from '@/App/constants';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { useI18n } from '@/i18n';
import { BottomDock } from './BottomDock';
import { LeftNav } from './LeftNav';
import { MainHeader } from './MainHeader';
import { RightDock } from './RightDock';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';

interface WorkspaceShellProps {
  onOpenSettings?: () => void;
  repositories?: Repository[];
  selectedRepoPath?: string | null;
  /** T-24: opens the shared AddRepositoryDialog mounted in App. */
  onAddRepository?: () => void;
  /**
   * T-24: drop zone for `useFileDragDrop`. Legacy binds this ref to its
   * repository sidebar; in the new shell the whole shell body is the target,
   * otherwise folder drops are swallowed with no feedback at all.
   */
  dropZoneRef?: Ref<HTMLDivElement>;
  fileDragOver?: boolean;
}

export function WorkspaceShell({
  onOpenSettings,
  repositories = [],
  selectedRepoPath = null,
  onAddRepository,
  dropZoneRef,
  fileDragOver = false,
}: WorkspaceShellProps) {
  const { t } = useI18n();
  const [leftNavCollapsed, setLeftNavCollapsed] = useState(false);
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [bottomDockOpen, setBottomDockOpen] = useState(false);
  const [rightDockTab, setRightDockTab] = useState<'git' | 'files' | 'context'>('git');

  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
  });

  const rightDockWidth = useMemo(() => (rightDockOpen ? 320 : 0), [rightDockOpen]);
  const bottomDockHeight = useMemo(() => (bottomDockOpen ? 220 : 0), [bottomDockOpen]);

  return (
    <div
      ref={dropZoneRef}
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background"
    >
      <LeftNav
        collapsed={leftNavCollapsed}
        onToggleCollapsed={() => setLeftNavCollapsed((value) => !value)}
        onOpenSettings={onOpenSettings}
        onAddRepository={onAddRepository}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <MainHeader
          rightDockOpen={rightDockOpen}
          bottomDockOpen={bottomDockOpen}
          onToggleRightDock={() => setRightDockOpen((value) => !value)}
          onToggleBottomDock={() => setBottomDockOpen((value) => !value)}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ChatWorkspace className="min-w-0 flex-1" />

          {rightDockOpen && (
            <RightDock
              activeTab={rightDockTab}
              onTabChange={setRightDockTab}
              width={rightDockWidth}
              onClose={() => setRightDockOpen(false)}
            />
          )}
        </div>

        {bottomDockOpen && (
          <BottomDock height={bottomDockHeight} onClose={() => setBottomDockOpen(false)} />
        )}
      </div>

      {fileDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-md border-2 border-primary border-dashed bg-primary/5">
          <span className="rounded-md bg-card px-3 py-1.5 text-sm text-foreground shadow-sm">
            {t('Add Repository')}
          </span>
        </div>
      )}
    </div>
  );
}

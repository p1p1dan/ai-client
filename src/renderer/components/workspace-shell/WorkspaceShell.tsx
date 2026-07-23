import { useMemo, useState } from 'react';
import type { Repository } from '@/App/constants';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { BottomDock } from './BottomDock';
import { LeftNav } from './LeftNav';
import { MainHeader } from './MainHeader';
import { RightDock } from './RightDock';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';

interface WorkspaceShellProps {
  onOpenSettings?: () => void;
  repositories?: Repository[];
  selectedRepoPath?: string | null;
}

export function WorkspaceShell({
  onOpenSettings,
  repositories = [],
  selectedRepoPath = null,
}: WorkspaceShellProps) {
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
    <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background">
      <LeftNav
        collapsed={leftNavCollapsed}
        onToggleCollapsed={() => setLeftNavCollapsed((value) => !value)}
        onOpenSettings={onOpenSettings}
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
    </div>
  );
}

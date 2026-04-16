import { Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import type { Session } from './SessionBar';
import type { AgentGroup as AgentGroupType } from './types';

interface AgentGroupProps {
  group: AgentGroupType;
  sessions: Session[];
  onGroupClick: () => void;
}

export function AgentGroup({ group, sessions, onGroupClick }: AgentGroupProps) {
  const { t } = useI18n();
  const bgImageEnabled = useSettingsStore((s) => s.backgroundImageEnabled);

  // Get sessions belonging to this group, preserving group.sessionIds order (for drag reorder)
  const groupSessions = useMemo(() => {
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return group.sessionIds
      .map((id) => sessionMap.get(id))
      .filter((s): s is Session => s !== undefined);
  }, [sessions, group.sessionIds]);

  const hasNoSessions = groupSessions.length === 0;
  if (!hasNoSessions) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click activates group
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground pointer-events-auto',
        !bgImageEnabled && 'bg-background'
      )}
      onClick={onGroupClick}
    >
      <Sparkles className="h-12 w-12 opacity-50" />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm">{t('No agent sessions')}</p>
        <p className="text-xs text-muted-foreground">{t('Create a session to start using AI Agent')}</p>
      </div>
    </div>
  );
}

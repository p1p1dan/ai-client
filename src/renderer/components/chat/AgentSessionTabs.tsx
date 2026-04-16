import { Plus, Terminal, X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import type { Session } from './SessionBar';
import type { AgentGroup as AgentGroupType } from './types';

interface AgentSessionTabsProps {
  group: AgentGroupType;
  sessions: Session[];
  isGroupActive: boolean;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: () => void;
  showQuickTerminal?: boolean;
  quickTerminalOpen?: boolean;
  quickTerminalHasProcess?: boolean;
  onToggleQuickTerminal?: () => void;
}

export function AgentSessionTabs({
  group,
  sessions,
  isGroupActive,
  onSelectSession,
  onCloseSession,
  onNewSession,
  showQuickTerminal = false,
  quickTerminalOpen,
  quickTerminalHasProcess,
  onToggleQuickTerminal,
}: AgentSessionTabsProps) {
  const { t } = useI18n();
  const bgImageEnabled = useSettingsStore((s) => s.backgroundImageEnabled);

  const groupSessions = useMemo(() => {
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return group.sessionIds.map((id) => sessionMap.get(id)).filter((s): s is Session => !!s);
  }, [sessions, group.sessionIds]);

  const activeSessionId = group.activeSessionId;

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
    },
    [onSelectSession]
  );

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      onCloseSession(sessionId);
    },
    [onCloseSession]
  );

  return (
    <div
      className={cn(
        'flex h-9 items-center border-b border-border',
        !bgImageEnabled && (isGroupActive ? 'bg-background' : 'bg-muted')
      )}
    >
      <div className="flex flex-1 min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groupSessions.map((session) => {
          const isActive = activeSessionId === session.id;
          const label = session.terminalTitle || session.name;
          return (
            <div
              key={session.id}
              onClick={(e) => {
                e.stopPropagation();
                handleSelectSession(session.id);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleSelectSession(session.id)}
              role="button"
              tabIndex={0}
              className={cn(
                'group relative flex h-9 min-w-[120px] max-w-[180px] items-center gap-2 border-r border-border px-3 text-sm transition-colors',
                isActive
                  ? cn(!bgImageEnabled && 'bg-background', 'text-foreground')
                  : cn(
                      !bgImageEnabled && 'bg-muted hover:bg-muted/80',
                      'text-muted-foreground hover:text-foreground'
                    )
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseSession(session.id);
                }}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
                  'hover:bg-destructive/20 hover:text-destructive',
                  !isActive && 'opacity-0 group-hover:opacity-100'
                )}
                aria-label={t('Close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1 border-l border-border px-1 shrink-0">
        {showQuickTerminal && onToggleQuickTerminal && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleQuickTerminal();
            }}
            className={cn(
              'relative flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
              quickTerminalOpen && 'bg-accent text-accent-foreground'
            )}
            title={t('Quick Terminal')}
            aria-label={t('Quick Terminal')}
          >
            <Terminal className="h-4 w-4" />
            {quickTerminalHasProcess && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title={t('New Session')}
          aria-label={t('New Session')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

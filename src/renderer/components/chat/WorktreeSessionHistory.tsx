import type { ClaudeProject, ClaudeSessionMeta } from '@shared/types';
import { History, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { pathsEqual } from '@/App/storage';
import { EmptyContent } from '@/components/ui/empty';
import { useI18n } from '@/i18n';
import { useClaudeProjects, useClaudeProjectSessions } from '@/hooks/useClaudeSessions';
import { SessionItem } from '@/components/sessions/SessionItem';

const MAX_HISTORY_ITEMS = 6;

interface WorktreeSessionHistoryProps {
  cwd: string;
  onResumeSession: (session: ClaudeSessionMeta, project: ClaudeProject) => void;
}

/**
 * Shown inside AgentPanel's empty state (no active session for this worktree).
 * Looks up whether Claude Code has prior history for this exact worktree path
 * (scanning the same `~/.claude/projects/` source as the Home session
 * browser) and offers a one-click resume. Renders nothing when there's no
 * match — the empty state's primary "New Session" CTA stays uncluttered.
 */
export function WorktreeSessionHistory({ cwd, onResumeSession }: WorktreeSessionHistoryProps) {
  const { t } = useI18n();
  const projectsQuery = useClaudeProjects();

  const matchedProject = useMemo(() => {
    const projects = projectsQuery.data ?? [];
    return projects.find((p) => pathsEqual(p.path, cwd)) ?? null;
  }, [projectsQuery.data, cwd]);

  const sessionsQuery = useClaudeProjectSessions(matchedProject?.id ?? null, {
    enabled: !!matchedProject,
  });

  if (!matchedProject) return null;

  if (sessionsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('Loading...')}
      </div>
    );
  }

  const sessions = (sessionsQuery.data ?? []).slice(0, MAX_HISTORY_ITEMS);
  if (sessions.length === 0) return null;

  return (
    <EmptyContent>
      <div className="flex items-center gap-1.5 self-start text-xs font-medium text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        {t('Previous sessions in this worktree')}
      </div>
      <div className="max-h-56 w-full min-w-0 space-y-1 overflow-auto">
        {sessions.map((session) => (
          <SessionItem
            key={session.id}
            onResumeSession={(s) => onResumeSession(s, matchedProject)}
            project={matchedProject}
            session={session}
          />
        ))}
      </div>
    </EmptyContent>
  );
}

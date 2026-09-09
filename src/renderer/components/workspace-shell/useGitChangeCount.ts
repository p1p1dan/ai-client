/**
 * T-22 (D19) acceptance ④: real changed-file count for the git rail dot.
 * `isActive=false` so this hook never introduces polling — see below.
 */
import { useGitStatus } from '@/hooks/useGit';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { countChangedFiles } from './surfaceRegistry';

export function useGitChangeCount(): number {
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const path = activeWorkspace?.path || null;

  // isActive=false makes useGitStatus's refetchInterval resolve to false
  // unconditionally (hooks/useGit.ts:24-27) — a rail dot must not add a 5s poll.
  const { data } = useGitStatus(path, false);

  // Honesty: a missing path or a failed/pending query both resolve `data` to
  // undefined here, so the count — and therefore the dot — falls back to 0
  // silently instead of guessing.
  return countChangedFiles(data ?? null);
}

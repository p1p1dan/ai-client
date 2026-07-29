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
  // unconditionally (hooks/useGit.ts:27-30) — a rail dot must not add a 5s poll.
  const { data } = useGitStatus(path, false);

  // Known side effect: useGitStatus's queryFn also calls
  // useRepositoryStore.setStatus(...) on every fetch (hooks/useGit.ts:14,23).
  // The new shell's ContextPanel does not mount the old git panel, so there is
  // no visible conflict today. If T-12 wires the git surface and wants a
  // different refresh strategy, start from hooks/useGit.ts.
  //
  // Honesty: a missing path or a failed/pending query both resolve `data` to
  // undefined here, so the count — and therefore the dot — falls back to 0
  // silently instead of guessing.
  return countChangedFiles(data ?? null);
}

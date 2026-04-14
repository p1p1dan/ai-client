import type { ClaudeProject, ClaudeSessionMeta } from '@shared/types';
import { useQuery } from '@tanstack/react-query';

export function useClaudeProjects(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: ['claude', 'projects'],
    queryFn: async (): Promise<ClaudeProject[]> => {
      return window.electronAPI.claudeSessions.listProjects();
    },
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useClaudeProjectSessions(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const enabled = (options?.enabled ?? true) && !!projectId;

  return useQuery({
    queryKey: ['claude', 'projectSessions', projectId],
    queryFn: async (): Promise<ClaudeSessionMeta[]> => {
      if (!projectId) return [];
      return window.electronAPI.claudeSessions.getProjectSessions(projectId);
    },
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

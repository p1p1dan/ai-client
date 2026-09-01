import type {
  LegacyImportBatchRequest,
  LegacyImportBatchResult,
  LegacyImportProject,
  LegacyImportSessionPreview,
} from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export function useLegacyImportProjects(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: ['legacy-import', 'projects'],
    queryFn: (): Promise<LegacyImportProject[]> => window.electronAPI.legacyImport.listProjects(),
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useLegacyImportSessions(projectId: string | null, options?: { enabled?: boolean }) {
  const enabled = (options?.enabled ?? true) && !!projectId;
  return useQuery({
    queryKey: ['legacy-import', 'sessions', projectId],
    queryFn: async (): Promise<LegacyImportSessionPreview[]> => {
      if (!projectId) return [];
      return window.electronAPI.legacyImport.listSessions(projectId);
    },
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useLegacyImportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: LegacyImportBatchRequest): Promise<LegacyImportBatchResult> =>
      window.electronAPI.legacyImport.importBatch(request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['legacy-import'] });
    },
  });
}

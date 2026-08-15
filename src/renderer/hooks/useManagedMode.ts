import { useQuery } from '@tanstack/react-query';

export interface ManagedModeInfo {
  managed: boolean;
  claudeHomeDir: string | null;
}

/**
 * D47 S2b §1 ④ (m6 first-frame race): default to `managed: true` until the
 * real `auth.managedMode()` IPC round trip resolves. Rendering the
 * managed-locked UI first and only relaxing it once we positively know the
 * flag is off avoids a one-frame flash of the raw local Provider UI — which
 * would otherwise leak that local providers/credentials are in play — when
 * managed mode is actually on.
 */
export const DEFAULT_MANAGED_MODE: ManagedModeInfo = { managed: true, claudeHomeDir: null };

export function useManagedMode() {
  const query = useQuery({
    queryKey: ['auth', 'managedMode'],
    queryFn: (): Promise<ManagedModeInfo> => window.electronAPI.auth.managedMode(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  return {
    ...query,
    data: query.data ?? DEFAULT_MANAGED_MODE,
  };
}

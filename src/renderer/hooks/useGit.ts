import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings';
import { gitQueryKeys } from './gitQueryKeys';
import { useShouldPoll } from './useWindowFocus';

interface GitQueryOptions {
  enabled?: boolean;
}

export function useGitStatus(workdir: string | null, isActive = true) {
  const shouldPoll = useShouldPoll();
  const gitAutoFetchEnabled = useSettingsStore((s) => s.gitAutoFetchEnabled);

  return useQuery({
    queryKey: gitQueryKeys.status(workdir),
    queryFn: async () => {
      if (!workdir) return null;
      const status = await window.electronAPI.git.getStatus(workdir);
      return status;
    },
    enabled: !!workdir,
    refetchInterval: (query) => {
      if (!isActive || !shouldPoll || !gitAutoFetchEnabled) return false;
      return query.state.data?.truncated ? 60000 : 5000;
    },
    refetchIntervalInBackground: false,
  });
}

export function useGitBranches(workdir: string | null, options?: GitQueryOptions) {
  const queryEnabled = options?.enabled ?? true;

  return useQuery({
    queryKey: gitQueryKeys.branches(workdir),
    queryFn: async () => {
      if (!workdir) return [];
      const branches = await window.electronAPI.git.getBranches(workdir);
      return branches;
    },
    enabled: !!workdir && queryEnabled,
  });
}

export function useGitCommit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      workdir,
      message,
      files,
    }: {
      workdir: string;
      message: string;
      files?: string[];
    }) => {
      return window.electronAPI.git.commit(workdir, message, files);
    },
    onSuccess: (_, { workdir }) => {
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.log(workdir) });
    },
  });
}

function invalidateBranchQueries(queryClient: QueryClient, workdir: string) {
  return Promise.all(
    [
      gitQueryKeys.status(workdir),
      gitQueryKeys.branches(workdir),
      gitQueryKeys.fileChanges(workdir),
      gitQueryKeys.fileDiff(workdir),
      gitQueryKeys.log(workdir),
      gitQueryKeys.logInfinite(workdir),
      gitQueryKeys.submodules(workdir),
      gitQueryKeys.submoduleChanges(workdir),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );
}

export function useGitCheckout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workdir, branch }: { workdir: string; branch: string }) => {
      await window.electronAPI.git.checkout(workdir, branch);
    },
    onSuccess: (_, { workdir }) => {
      return invalidateBranchQueries(queryClient, workdir);
    },
  });
}

export function useGitCreateBranch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      workdir,
      name,
      startPoint,
    }: {
      workdir: string;
      name: string;
      startPoint?: string;
    }) => {
      await window.electronAPI.git.createBranch(workdir, name, startPoint);
    },
    onSuccess: (_, { workdir }) => {
      // GitService.createBranch uses checkoutBranch, so HEAD changes here too.
      return invalidateBranchQueries(queryClient, workdir);
    },
  });
}

/**
 * Hook to listen for auto-fetch completion events and refresh git status.
 * Should be called once at the app root level.
 */
export function useAutoFetchListener() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const cleanup = window.electronAPI.git.onAutoFetchCompleted(() => {
      // Invalidate all git status queries to refresh behind/ahead counts
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status() });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches() });
      queryClient.invalidateQueries({ queryKey: ['worktree', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['worktree', 'listMultiple'] });
    });

    return cleanup;
  }, [queryClient]);
}

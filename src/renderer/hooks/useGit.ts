import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { normalizePath } from '@/App/storage';
import { useRepositoryStore } from '@/stores/repository';
import { useSettingsStore } from '@/stores/settings';
import { gitQueryKeys } from './gitQueryKeys';
import { useShouldPoll } from './useWindowFocus';

interface GitQueryOptions {
  enabled?: boolean;
}

export function useGitStatus(workdir: string | null, isActive = true) {
  const setStatus = useRepositoryStore((s) => s.setStatus);
  const shouldPoll = useShouldPoll();
  const gitAutoFetchEnabled = useSettingsStore((s) => s.gitAutoFetchEnabled);

  return useQuery({
    queryKey: gitQueryKeys.status(workdir),
    queryFn: async () => {
      if (!workdir) return null;
      const status = await window.electronAPI.git.getStatus(workdir);
      setStatus(status);
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
  const setBranches = useRepositoryStore((s) => s.setBranches);
  const queryEnabled = options?.enabled ?? true;

  return useQuery({
    queryKey: gitQueryKeys.branches(workdir),
    queryFn: async () => {
      if (!workdir) return [];
      const branches = await window.electronAPI.git.getBranches(workdir);
      setBranches(branches);
      return branches;
    },
    enabled: !!workdir && queryEnabled,
  });
}

export function useGitLog(workdir: string | null, maxCount = 50) {
  const setLogs = useRepositoryStore((s) => s.setLogs);

  return useQuery({
    queryKey: gitQueryKeys.log(workdir, maxCount),
    queryFn: async () => {
      if (!workdir) return [];
      const logs = await window.electronAPI.git.getLog(workdir, maxCount);
      setLogs(logs);
      return logs;
    },
    enabled: !!workdir,
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

export function useGitCheckout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workdir, branch }: { workdir: string; branch: string }) => {
      await window.electronAPI.git.checkout(workdir, branch);
    },
    onSuccess: (_, { workdir }) => {
      // Invalidate all git-related queries after branch switch
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.fileChanges(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.fileDiff(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.log(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.logInfinite(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.submodules(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.submoduleChanges(workdir) });
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
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(workdir) });
    },
  });
}

export function useGitPush() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      workdir,
      remote,
      branch,
      setUpstream,
    }: {
      workdir: string;
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
    }) => {
      await window.electronAPI.git.push(workdir, remote, branch, setUpstream);
    },
    onSuccess: (_, { workdir }) => {
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(workdir) });
    },
  });
}

export function useGitPull() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      workdir,
      remote,
      branch,
    }: {
      workdir: string;
      remote?: string;
      branch?: string;
    }) => {
      await window.electronAPI.git.pull(workdir, remote, branch);
    },
    onSuccess: (_, { workdir }) => {
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.log(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.logInfinite(workdir) });
    },
  });
}

export function useGitDiff(workdir: string | null, staged = false) {
  return useQuery({
    queryKey: gitQueryKeys.diff(workdir, staged),
    queryFn: async () => {
      if (!workdir) return '';
      return window.electronAPI.git.getDiff(workdir, { staged });
    },
    enabled: !!workdir,
  });
}

export function useGitInit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (workdir: string) => {
      await window.electronAPI.git.init(workdir);
    },
    onSuccess: (_, workdir) => {
      // Invalidate all git-related queries for this workdir
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(workdir) });
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(workdir) });
      // Not a git key — worktree has its own namespace, out of gitQueryKeys' scope.
      queryClient.invalidateQueries({ queryKey: ['worktree', 'list', normalizePath(workdir)] });
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

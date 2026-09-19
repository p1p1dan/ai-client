/**
 * T100: keep the git panel's commit history and branch list current when the
 * repository is changed from outside the app.
 *
 * The panel already polls the two working-tree queries every 5s (file-changes
 * in `useSourceControl.ts`, status in `useGit.ts`), so a file edited in a
 * terminal shows up on its own. History and branches had no such path: they
 * were only invalidated by the app's own commit/checkout/create-branch
 * mutations, and the branch list additionally refetched when the dropdown was
 * opened. A `git commit` or `git checkout` typed in a terminal — or run by an
 * agent — therefore stayed invisible for as long as the panel stayed open.
 *
 * Rather than polling those two (a `git log` page plus `git branch -a -v` with
 * merge detection every 5s, for data that changes rarely), this polls a cheap
 * refs-only fingerprint at the same cadence (`GitService.getHeadSignature`) and
 * invalidates history and branches only when the fingerprint actually moves.
 *
 * Why its own query instead of riding the existing status poll: `useGitStatus`
 * stops polling entirely when the user turns OFF the "git auto fetch" setting
 * (`useGit.ts`), which is about contacting the remote and has nothing to do
 * with noticing local external commits. Hanging T100 off that switch would make
 * the feature silently dead for those users, so the fingerprint polls on the
 * same terms as file-changes instead: panel active + window not idle.
 *
 * Deliberately NOT a `.git/` filesystem watcher — that is a separate decision
 * (D: watcher deferred), and this needs no new main-process lifecycle.
 */
import type { GitHeadSignature } from '@shared/types';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { gitQueryKeys } from './gitQueryKeys';
import { useShouldPoll, useWindowFocus } from './useWindowFocus';

/** Same cadence as the file-changes/status polls this rides alongside. */
const HEAD_SIGNATURE_POLL_MS = 5000;

/**
 * The queries whose contents are decided by HEAD and the branch refs rather
 * than by the working tree. `log` and `log-infinite` are both here because the
 * panel renders the infinite one while other surfaces use the flat one, and a
 * stale page in either is the same defect.
 */
function headDependentKeys(workdir: string): readonly (readonly unknown[])[] {
  return [
    gitQueryKeys.log(workdir),
    gitQueryKeys.logInfinite(workdir),
    gitQueryKeys.branches(workdir),
  ];
}

function invalidateHeadDependentQueries(queryClient: QueryClient, workdir: string): void {
  for (const queryKey of headDependentKeys(workdir)) {
    queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Comparable form of a signature. IPC hands back a fresh object every tick, so
 * the comparison has to be by value; `null` means "nothing to compare" (no
 * workdir yet, or a backend with no local refs, e.g. a remote repository).
 */
export function serializeHeadSignature(
  signature: GitHeadSignature | null | undefined
): string | null {
  if (!signature) return null;
  return `${signature.head ?? ''}\n${signature.ref ?? ''}\n${signature.refs}`;
}

export interface GitExternalRefresh {
  /**
   * Manual refresh (the panel's refresh button): re-reads the working tree AND
   * the head-dependent queries, so one click covers everything the panel shows
   * instead of only the changed-files list.
   */
  refresh: () => void;
}

export function useGitExternalRefresh(workdir: string | null, isActive = true): GitExternalRefresh {
  const queryClient = useQueryClient();
  const shouldPoll = useShouldPoll();
  const { isWindowFocused } = useWindowFocus();

  const signatureQuery = useQuery({
    queryKey: gitQueryKeys.headSignature(workdir),
    queryFn: async (): Promise<GitHeadSignature | null> => {
      if (!workdir) return null;
      return window.electronAPI.git.getHeadSignature(workdir);
    },
    enabled: !!workdir,
    // The only value of this query is being current; a cached reading would
    // just delay the refresh it exists to trigger.
    staleTime: 0,
    refetchInterval: isActive && shouldPoll ? HEAD_SIGNATURE_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  const signature = serializeHeadSignature(signatureQuery.data);

  /**
   * What the currently rendered history/branches were read against. A `null`
   * signature means "no baseline yet": the first reading after a mount or a
   * workdir switch establishes one and must not invalidate, or every panel
   * open would throw away caches that are already correct.
   */
  const observedRef = useRef<{ workdir: string | null; signature: string | null }>({
    workdir,
    signature: null,
  });

  useEffect(() => {
    const observed = observedRef.current;
    if (observed.workdir !== workdir) {
      // Another repository: its keys are workdir-scoped, so nothing carries
      // over and this reading is that repository's baseline.
      observedRef.current = { workdir, signature };
      return;
    }
    if (signature === null || signature === observed.signature) return;
    observedRef.current = { workdir, signature };
    if (observed.signature === null || !workdir) return;
    invalidateHeadDependentQueries(queryClient, workdir);
  }, [queryClient, signature, workdir]);

  const wasWindowFocusedRef = useRef(isWindowFocused);

  useEffect(() => {
    const wasFocused = wasWindowFocusedRef.current;
    wasWindowFocusedRef.current = isWindowFocused;
    if (!workdir || !isWindowFocused || wasFocused) return;
    // Polling is suspended while the window is in the background, so the panel
    // can be arbitrarily far behind by the time it comes back. React Query's
    // own refetch-on-focus would not cover this: the app sets a 60s global
    // `staleTime` (renderer/index.tsx), so a query fetched moments before the
    // blur is still "fresh" on return. Invalidating ignores that.
    invalidateHeadDependentQueries(queryClient, workdir);
    queryClient.invalidateQueries({ queryKey: gitQueryKeys.headSignature(workdir) });
  }, [isWindowFocused, queryClient, workdir]);

  const refresh = useCallback(() => {
    if (!workdir) return;
    queryClient.invalidateQueries({ queryKey: gitQueryKeys.fileChanges(workdir) });
    invalidateHeadDependentQueries(queryClient, workdir);
    queryClient.invalidateQueries({ queryKey: gitQueryKeys.headSignature(workdir) });
  }, [queryClient, workdir]);

  return { refresh };
}

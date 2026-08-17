/**
 * T-27: single effect-collection point for the Composer target bar. UI
 * components (ComposerTargetBar / TargetFolderSelect / TargetBranchSelect /
 * RunLocationIndicator) only read the derived data below and call the
 * exposed callbacks — every store read/write and query lives here so those
 * components stay presentational.
 *
 * Batch 3 adds the pending-target flow: `createTempTarget` (New Folder) and
 * `awaitWorkspaceAtPath` (New worktree success) both stash the path they're
 * waiting for, and a `workspaces`-driven effect below applies it once the
 * tree sync (`useSyncChatWorkspaceTree`) has re-derived the new workspace —
 * see T-27 design §2.3 point 4-5 and risk R2 (must not race
 * `rebindSessionsToTree`'s own `activeSessionId` recompute).
 */

import { getEffectiveTemporaryBasePath } from '@shared/defaultPaths';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useRepositoryRuntimeContext } from '@/hooks/useRepositoryRuntimeContext';
import { useI18n } from '@/i18n';
import { createChatSessionOnWorkspace, retargetChatSession } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsStore } from '@/stores/settings';
import { useTempWorkspaceStore } from '@/stores/tempWorkspace';
import {
  type ActiveTarget,
  type BranchMenuModel,
  buildBranchMenu,
  buildFolderMenu,
  decideTargetChange,
  type FolderMenuModel,
  matchWorkspaceByPath,
  planTargetChange,
  resolveActiveTarget,
  resolveRuntimeRepoPath,
  runLocationLabel,
  shouldShowBranchSelect,
  targetWorktreeLabel,
} from './composerTarget';
import { markForkDraftCarry } from './forkDraftCarry';
// D48 S1: `computeEverHostBound` moved out of this file — the agent picker's
// lock and the target bar's lock have to be the same sentence, and this file
// already had two documented mirrors elsewhere in the tree.
import { computeEverHostBound } from './sessionBinding';

export interface UseComposerTargetResult {
  target: ActiveTarget;
  folderMenu: FolderMenuModel;
  branchMenu: BranchMenuModel;
  blocked: boolean;
  showBranchSelect: boolean;
  branchLabel: string | null;
  runLocation: { text: string; tone: 'local' | 'remote' } | null;
  /** User picked a workspace in either dropdown. */
  selectTarget: (workspaceId: string) => void;
  /**
   * New Folder footer action: creates a temp workspace, then auto-switches to
   * it. `undefined` when the `temporaryWorkspaceEnabled` setting is off
   * (parity with the legacy shells' Temp gating) — `TargetFolderSelect` only
   * renders the footer entry when this is defined.
   */
  createTempTarget?: () => Promise<void>;
  /** New worktree success handler: waits for the path to land in `workspaces`, then auto-switches. */
  awaitWorkspaceAtPath: (path: string) => void;
  /** workdir for the controlled CreateWorktreeDialog (project's main/remote workspace path). */
  worktreeRepoPath: string | null;
  /** projectName for the controlled CreateWorktreeDialog. */
  worktreeProjectName: string;
}

interface PendingTarget {
  path: string;
  kind: 'worktree' | 'temp';
  /** activeSessionId at the moment the pending target was set, or null. */
  sourceSessionId: string | null;
}

/**
 * Applies a pending target (new worktree / temp workspace) once its
 * workspace has landed in `workspaces`. Reads a fresh store snapshot via
 * `getState()` instead of closing over render-time `sessions` / `messages` /
 * `hostBoundSessionIds` — those can be several ticks stale by the time the
 * new workspace finally appears in the tree (T-27 design §2.3 point 4-5,
 * risk R2), and the source session may no longer even be the active one if
 * the user navigated away while the worktree/temp workspace was created.
 *
 * Returns false — and leaves the pending target in place — when the plan
 * comes back 'blocked' (e.g. the source session is mid-run), so the caller
 * retries on the next `workspaces` change or the 5s give-up timer.
 */
function applyPendingTarget(nextWorkspaceId: string, pending: PendingTarget): boolean {
  const state = useChatSessionsStore.getState();
  const sourceSession = pending.sourceSessionId
    ? state.sessions.find((session) => session.id === pending.sourceSessionId)
    : undefined;
  const messageCount = sourceSession ? (state.messages[sourceSession.id]?.length ?? 0) : 0;
  const everHostBound = computeEverHostBound(sourceSession, state.hostBoundSessionIds);

  const plan = planTargetChange({
    nextWorkspaceId,
    activeSession: sourceSession,
    workspaces: state.workspaces,
    messageCount,
    hostBound: everHostBound,
  });

  switch (plan.kind) {
    case 'blocked':
      return false;
    case 'noop':
      return true;
    case 'retarget':
      retargetChatSession(plan.sessionId, plan.workspaceId);
      // The source session may no longer be the active one — select it
      // explicitly so the user actually sees the switch land.
      if (useChatSessionsStore.getState().activeSessionId !== plan.sessionId) {
        useChatSessionsStore.getState().selectSession(plan.sessionId);
      }
      return true;
    case 'fork': {
      const newSessionId = createChatSessionOnWorkspace(plan.workspaceId, plan.title);
      if (newSessionId) {
        useChatSessionsStore.getState().selectSession(newSessionId);
        markForkDraftCarry(newSessionId);
      }
      return true;
    }
    default:
      return true;
  }
}

export function useComposerTarget(input: {
  sending: boolean;
  disabled?: boolean;
}): UseComposerTargetResult {
  const { t } = useI18n();
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const projects = useChatSessionsStore((state) => state.projects);
  const hostBoundSessionIds = useChatSessionsStore((state) => state.hostBoundSessionIds);
  const messageCount = useChatSessionsStore((state) =>
    state.activeSessionId ? (state.messages[state.activeSessionId]?.length ?? 0) : 0
  );

  const target = useMemo(
    () => resolveActiveTarget({ activeSessionId, sessions, workspaces, projects }),
    [activeSessionId, sessions, workspaces, projects]
  );

  const everHostBound = computeEverHostBound(target.session, hostBoundSessionIds);

  const outcomeBlocked =
    decideTargetChange({
      status: target.session?.status,
      messageCount,
      hostBound: everHostBound,
      sending: input.sending,
    }) === 'blocked';
  // A general `disabled` kill switch (e.g. ChatComposer's own `disabled`
  // prop) must also lock the target selectors, not just the three-tier rule.
  const blocked = outcomeBlocked || Boolean(input.disabled);

  const folderMenu = useMemo(
    () =>
      buildFolderMenu({
        projects,
        workspaces,
        sessions,
        activeWorkspaceId: target.workspace?.id ?? null,
      }),
    [projects, workspaces, sessions, target.workspace?.id]
  );

  const branchMenu = useMemo(
    () =>
      buildBranchMenu({
        projectId: target.workspace?.projectId ?? null,
        workspaces,
        sessions,
        activeWorkspaceId: target.workspace?.id ?? null,
      }),
    [target.workspace?.projectId, target.workspace?.id, workspaces, sessions]
  );

  const showBranchSelect = shouldShowBranchSelect(target.workspace);
  const branchLabel = targetWorktreeLabel(target.workspace);

  // Run location is a repository property (T-27 decision #6): resolve the
  // project's main/remote workspace path, not the currently targeted
  // worktree's own path.
  const repoPath = resolveRuntimeRepoPath(target.workspace?.id ?? null, workspaces);
  const { data: runtimeContext } = useRepositoryRuntimeContext(repoPath ?? undefined);
  const { data: profiles } = useQuery({
    queryKey: ['remote', 'profiles'],
    queryFn: () => window.electronAPI.remote.listProfiles(),
    enabled: runtimeContext?.kind === 'remote',
    staleTime: 60_000,
  });
  const runLocation = runLocationLabel({ context: runtimeContext, profiles, repoPath });

  const selectTarget = useCallback(
    (workspaceId: string) => {
      if (input.disabled) {
        return;
      }
      const plan = planTargetChange({
        nextWorkspaceId: workspaceId,
        activeSession: target.session,
        workspaces,
        messageCount,
        hostBound: everHostBound,
        sending: input.sending,
      });

      switch (plan.kind) {
        case 'noop':
        case 'blocked':
          return;
        case 'retarget':
          retargetChatSession(plan.sessionId, plan.workspaceId);
          return;
        case 'fork': {
          // plan.kind === 'fork' while an active session exists means the
          // outcome came from decideTargetChange (messages / host-bound) —
          // that's the only case that needs the heads-up toast. A fork onto
          // a target with no active session at all is a silent, expected
          // "give it one" (T-27 design §2.3).
          const hadActiveSession = target.session !== undefined;
          const newSessionId = createChatSessionOnWorkspace(plan.workspaceId, plan.title);
          if (newSessionId) {
            // createChatSessionOnWorkspace already sets activeSessionId;
            // this call keeps "select after fork" explicit and independent
            // of that implementation detail.
            useChatSessionsStore.getState().selectSession(newSessionId);
            // T-27 fix: a fork carries the composer's in-flight attachment
            // drafts onto the new session — mark it so ChatComposer's
            // session-switch effect skips its usual draft clear.
            markForkDraftCarry(newSessionId);
            if (hadActiveSession) {
              toastManager.add({
                title: t(
                  'This chat already has messages — a new chat will start on the new target'
                ),
                type: 'info',
              });
            }
          }
          return;
        }
        default:
          return;
      }
    },
    [input.disabled, input.sending, target.session, workspaces, messageCount, everHostBound, t]
  );

  // ---- Pending target flow (batch 3): temp workspace / new worktree creation ----

  const worktreeRepoPath = repoPath;
  const worktreeProjectName = target.project?.name ?? '';

  const queryClient = useQueryClient();
  const defaultTemporaryPath = useSettingsStore((state) => state.defaultTemporaryPath);
  const temporaryWorkspaceEnabled = useSettingsStore((state) => state.temporaryWorkspaceEnabled);
  const addTempWorkspace = useTempWorkspaceStore((state) => state.addItem);

  const [pendingTarget, setPendingTarget] = useState<PendingTarget | null>(null);

  // Applies the pending target once it shows up in the tree. Depends only on
  // `workspaces` / `pendingTarget` (not e.g. a derived boolean) so it
  // re-checks precisely when `useSyncChatWorkspaceTree`'s
  // `rebindSessionsToTree` has landed — applying before that would get
  // silently overwritten (risk R2). `applyPendingTarget` reads its own fresh
  // store snapshot, so this effect does not need `selectTarget` in its
  // dependency list.
  useEffect(() => {
    if (!pendingTarget) {
      return;
    }
    const match = matchWorkspaceByPath(pendingTarget.path, workspaces);
    if (!match) {
      return;
    }
    const applied = applyPendingTarget(match.id, pendingTarget);
    if (applied) {
      setPendingTarget(null);
    }
    // else: plan came back 'blocked' (source session mid-run) — keep the
    // pending target; the next `workspaces` change re-runs this effect, and
    // the give-up timer below is the final fallback.
  }, [workspaces, pendingTarget]);

  // Give-up timers anchored to when `pendingTarget` was set, independent of
  // how many times `workspaces` itself changes while we wait (R4/R2).
  useEffect(() => {
    if (!pendingTarget) {
      return;
    }
    const invalidateTimer = window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['worktree', 'listMultiple'] });
    }, 1200);
    const giveUpTimer = window.setTimeout(() => {
      setPendingTarget(null);
      toastManager.add({
        type: 'info',
        title: t(
          pendingTarget.kind === 'worktree'
            ? 'Worktree created — pick it from the branch list'
            : 'Temp workspace created — pick it from the folder list'
        ),
      });
    }, 5000);
    return () => {
      window.clearTimeout(invalidateTimer);
      window.clearTimeout(giveUpTimer);
    };
  }, [pendingTarget, queryClient, t]);

  const awaitWorkspaceAtPath = useCallback((path: string) => {
    setPendingTarget({
      path,
      kind: 'worktree',
      sourceSessionId: useChatSessionsStore.getState().activeSessionId,
    });
  }, []);

  const createTempTargetImpl = useCallback(async () => {
    // Defense-in-depth: the footer entry that calls this is already hidden
    // when the setting is off (see the `createTempTarget` return below), but
    // guard the action itself in case a stale handler reference ever fires.
    if (!temporaryWorkspaceEnabled) {
      return;
    }

    const isWindows = window.electronAPI?.env.platform === 'win32';
    const pathSep = isWindows ? '\\' : '/';
    const homeDir = window.electronAPI?.env.HOME || '';
    // Same derivation as App.tsx:458-461's `effectiveTempBasePath`.
    const basePath = getEffectiveTemporaryBasePath(defaultTemporaryPath, homeDir, pathSep);

    const result = await window.electronAPI.tempWorkspace.create(basePath);
    if (!result.ok) {
      toastManager.add({
        type: 'error',
        title: t('Failed to create temp workspace'),
        description: result.message || t('Failed to create temp workspace'),
      });
      return;
    }

    addTempWorkspace(result.item);
    toastManager.add({ type: 'success', title: t('Temp workspace created') });
    setPendingTarget({
      path: result.item.path,
      kind: 'temp',
      sourceSessionId: useChatSessionsStore.getState().activeSessionId,
    });
  }, [temporaryWorkspaceEnabled, defaultTemporaryPath, addTempWorkspace, t]);

  // Primary gate: `TargetFolderSelect` renders the "New Folder / Temporary
  // workspace" footer entry only when `onCreateTempTarget` is defined, so
  // handing back `undefined` here hides it (parity with the legacy shells'
  // `{temporaryWorkspaceEnabled && (...)}` gate).
  const createTempTarget = temporaryWorkspaceEnabled ? createTempTargetImpl : undefined;

  return {
    target,
    folderMenu,
    branchMenu,
    blocked,
    showBranchSelect,
    branchLabel,
    runLocation,
    selectTarget,
    createTempTarget,
    awaitWorkspaceAtPath,
    worktreeRepoPath,
    worktreeProjectName,
  };
}

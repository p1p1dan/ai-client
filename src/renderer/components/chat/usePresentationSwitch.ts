/**
 * D07: the GUI ⇄ TUI switch, extracted from `ChatWorkspace` so two components
 * can share one instance of it.
 *
 * The buttons moved up into the shell's single header bar (`MainHeader`) while
 * the terminal itself is still rendered by `ChatWorkspace`. Neither may import
 * the other — `components/chat` importing `components/workspace-shell` is a
 * guarded dependency direction (`composerTargetGuards.test.ts`) — so the SHELL
 * owns this hook and hands both halves what they need. This module stays under
 * `components/chat` because the semantics are chat's: which JSONL the terminal
 * takes over, and when it is safe to hand it across.
 *
 * Nothing about the handover changed in the move. `openTui` still refuses
 * mid-turn, `openGui` still suspends-then-reloads, and the two dispose effects
 * still run — they simply hang off the shell's lifetime instead of the chat
 * column's, which is the same lifetime in practice (the chat column is hidden,
 * never unmounted).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { addToast } from '@/components/ui/toast';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useScratchWorkspaceStore } from '@/stores/scratchWorkspace';
import { useSettingsStore } from '@/stores/settings';
import type { PresentationMode } from '@/stores/settings/types';
import { isSessionBusy } from './sessionIndex/resumeIntent';

export interface PresentationSwitch {
  presentationMode: PresentationMode;
  openGui: () => void;
  openTui: () => void;
  /**
   * The terminal PROCESS ended on its own (the user typed `exit`, or pi quit).
   * Distinct from `openGui`: there is no session to suspend and reload — the
   * terminal is already gone — so this drops the id and falls back to the
   * timeline instead of running the handover.
   */
  handleTuiExit: () => void;
  /** Non-null once the TUI has been entered at least once this app run. */
  tuiTerminalId: string | null;
  /** True while leaving the TUI, until the session has been re-read from disk. */
  surfaceSwitching: boolean;
  /** U03-b: the directory the Pi TUI opens in — bound folder, else scratch. */
  effectiveCwd: string;
}

export function usePresentationSwitch(): PresentationSwitch {
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const activeWorkspacePath = activeWorkspace?.path?.trim() ?? '';

  const scratchCwd = useScratchWorkspaceStore((state) =>
    activeSessionId ? (state.pathsBySession[activeSessionId] ?? null) : null
  );
  const ensureScratchWorkspace = useScratchWorkspaceStore((state) => state.ensure);
  const effectiveCwd = activeWorkspacePath || (scratchCwd ?? '');

  const presentationMode = useSettingsStore((state) => state.presentationMode);
  const setPresentationMode = useSettingsStore((state) => state.setPresentationMode);
  const [tuiTerminalId, setTuiTerminalId] = useState<string | null>(null);
  const [surfaceSwitching, setSurfaceSwitching] = useState(false);
  const previousWorkspacePathRef = useRef(activeWorkspacePath);

  // U03-b: the gate used to be "this chat has a bound folder". It is now
  // "this chat has a usable cwd" — an unbound chat qualifies, it just has to
  // have its directory allocated first, which is why this became async.
  const openTui = useCallback(() => {
    if (!activeSessionId) return;
    // pix refuses the switch mid-turn instead of killing or waiting on it, and
    // the same has to hold here for a sharper reason: handing the file to the
    // terminal while the worker is still writing it would give one JSONL two
    // live writers. `isSessionBusy` is the same predicate the resume path uses
    // to decide the Host would reject a request.
    //
    // Read the status off the store rather than closing over it, for the same
    // reason `markSendAttempt` does: a callback captured at render time would
    // decide with the status that was current then, and "is a turn running" has
    // to be answered at the moment of the click.
    const liveStatus = useChatSessionsStore
      .getState()
      .sessions.find((session) => session.id === activeSessionId)?.status;
    if (isSessionBusy(liveStatus ?? 'idle')) {
      addToast({
        type: 'warning',
        title: 'Wait for this turn to finish',
        description: 'The Pi TUI can take over this chat once the current turn ends.',
      });
      return;
    }
    const start = () => {
      setPresentationMode('tui');
      setTuiTerminalId((current) => current ?? `pi-tui-${crypto.randomUUID()}`);
    };
    if (effectiveCwd) {
      start();
      return;
    }
    void ensureScratchWorkspace(activeSessionId).then(start, (error: unknown) => {
      addToast({
        type: 'error',
        title: 'Could not start the Pi TUI',
        description:
          error instanceof Error ? error.message : 'Failed to prepare a temporary folder.',
      });
    });
  }, [activeSessionId, effectiveCwd, ensureScratchWorkspace, setPresentationMode]);

  /**
   * Leave terminal mode the way pix's `leaveTerminalMode()` does: suspend the
   * TUI, re-read the session from disk, and only then show the timeline.
   *
   * The reload is the whole point. The TUI appends to this chat's own JSONL,
   * but the GUI worker read that file once when it started and never looks
   * again — so without this step the timeline still shows the pre-TUI
   * conversation AND the worker's next turn branches off the pre-TUI entry,
   * leaving everything typed in the terminal on an abandoned path.
   *
   * Suspend rather than dispose: the process stays warm so re-entering is
   * instant. That is safe because the only way the GUI writes this file is
   * through the send path, which kills terminals on it first — a suspended
   * terminal can never wake up onto a file the GUI has since written.
   */
  const openGui = useCallback(() => {
    const terminalId = tuiTerminalId;
    const sessionId = activeSessionId;
    setPresentationMode('gui');
    if (!terminalId || !sessionId) return;
    setSurfaceSwitching(true);
    void (async () => {
      try {
        await window.electronAPI.piTui.suspend(terminalId);
        await window.electronAPI.chat.reloadSession({ sessionId });
      } catch (error) {
        // The timeline may now be behind the file with no way to tell how far,
        // so drop the terminal rather than leave a warm one that could append
        // again on top of a history nobody reloaded.
        void window.electronAPI.piTui.dispose(terminalId).catch(() => {});
        setTuiTerminalId(null);
        addToast({
          type: 'error',
          title: 'Could not reload this chat',
          description:
            error instanceof Error
              ? error.message
              : 'The conversation could not be re-read from disk.',
        });
      } finally {
        setSurfaceSwitching(false);
      }
    })();
  }, [activeSessionId, setPresentationMode, tuiTerminalId]);

  const handleTuiExit = useCallback(() => {
    setTuiTerminalId(null);
    setPresentationMode('gui');
    addToast({
      type: 'warning',
      title: 'Pi TUI closed',
      description: 'Returned to the GUI session.',
    });
  }, [setPresentationMode]);

  useEffect(() => {
    if (!tuiTerminalId) return;
    return () => {
      void window.electronAPI.piTui.dispose(tuiTerminalId).catch(() => {});
    };
  }, [tuiTerminalId]);

  useEffect(() => {
    if (previousWorkspacePathRef.current === activeWorkspacePath) return;
    previousWorkspacePathRef.current = activeWorkspacePath;
    setTuiTerminalId((current) => {
      if (current) void window.electronAPI.piTui.dispose(current).catch(() => {});
      return null;
    });
  }, [activeWorkspacePath]);

  return {
    presentationMode,
    openGui,
    openTui,
    handleTuiExit,
    tuiTerminalId,
    surfaceSwitching,
    effectiveCwd,
  };
}

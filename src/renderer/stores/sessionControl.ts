import type { SessionControlChange } from '@shared/types/sessionControl';
import { create } from 'zustand';

/**
 * Which sessions a plugin's client controls right now (plugin-system README
 * §4); every session not listed is the desktop's. Mirrors Main: read once,
 * then kept current by its pushes.
 */

export interface RemoteController {
  label: string;
  pluginId: string;
}

interface SessionControlState {
  remote: Record<string, RemoteController>;
}

export const useSessionControlStore = create<SessionControlState>(() => ({ remote: {} }));

export function applySessionControlChange(change: SessionControlChange): void {
  useSessionControlStore.setState((state) => {
    const remote = { ...state.remote };
    if (change.controller.kind === 'client') {
      remote[change.sessionId] = {
        label: change.controller.label,
        pluginId: change.controller.pluginId,
      };
    } else {
      delete remote[change.sessionId];
    }
    return { remote };
  });
}

let syncing = false;

/** Start mirroring Main; idempotent. */
export function ensureSessionControlSync(): void {
  if (syncing) return;
  const chat = typeof window === 'undefined' ? undefined : window.electronAPI?.chat;
  if (!chat?.getSessionControls) return;
  syncing = true;
  chat.onSessionControlChanged(applySessionControlChange);
  chat.getSessionControls().then(
    (changes) => {
      for (const change of changes) applySessionControlChange(change);
    },
    (error: unknown) => console.warn('[sessionControl] could not read controllers:', error)
  );
}

/** The plugin client using `sessionId`, or `undefined` when the desktop controls it. */
export function useRemoteController(
  sessionId: string | null | undefined
): RemoteController | undefined {
  ensureSessionControlSync();
  return useSessionControlStore((state) => (sessionId ? state.remote[sessionId] : undefined));
}

export async function takeOverSession(sessionId: string): Promise<void> {
  await window.electronAPI.chat.takeOverSession({ sessionId });
}

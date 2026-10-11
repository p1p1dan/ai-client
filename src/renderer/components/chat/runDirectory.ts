/**
 * Where a conversation runs: one rule for a send and for every start made on a
 * send's behalf (dsh-rebase decision 176, GUI point-check fix 2026-10-11).
 *
 *  1. Its folder, when it has one this window can run in.
 *  2. Else the scratch directory recorded on it (`session.unbound`): a
 *     temporary chat reopened after a restart, or one a fork made.
 *  3. Else it is a temporary chat this window holds no record for, and runs in
 *     its scratch directory, which Main allocates on first use and names again
 *     afterwards. A temporary chat made in this run is one: nothing writes
 *     `unbound` on it before a restart (`createUnboundChatSession`).
 *
 * `runSend` reads 1–2 off its render and asks 3 inside its handshake, raced
 * against Stop. The start an operation makes (`sessionStart.ts`) and the
 * history card's Retry (`resumeSessionById`) read the session alone before,
 * so a temporary chat made in this run that the engine had let go was refused
 * as having no folder — 「压缩上下文失败 / 这个对话没有可以运行的文件夹。」 —
 * while a message sent in it went through.
 */

import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { useScratchWorkspaceStore } from '@/stores/scratchWorkspace';
import { isTargetableWorkspace } from './composerTarget';

/** Rules 1–2: the directory this window knows without asking Main; `null` means rule 3. */
export function knownRunDirectory(
  session: Pick<ChatSession, 'unbound'> | undefined,
  workspace: ChatWorkspace | undefined
): string | null {
  if (workspace && isTargetableWorkspace(workspace)) return workspace.path;
  return session?.unbound?.workspacePath || null;
}

/** Rule 3: the temporary chat's scratch directory, allocated on first use, the same one afterwards. */
export function ensureScratchRunDirectory(sessionId: string): Promise<string> {
  return useScratchWorkspaceStore.getState().ensure(sessionId);
}

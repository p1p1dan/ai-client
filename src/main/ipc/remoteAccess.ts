import { sessionLiveJournal } from '../services/remoteAccess';
import { onChatRuntimeEvent } from './chat';

/**
 * Issue #25 — remote access to chats.
 *
 * The journal records from app start rather than from when a remote client
 * first connects: a client that arrives mid-turn needs the turn that was
 * already running.
 */
export function registerRemoteAccessHandlers(): void {
  onChatRuntimeEvent((event) => {
    sessionLiveJournal.record(event);
  });
}

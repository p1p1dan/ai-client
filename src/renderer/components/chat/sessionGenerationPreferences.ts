import type { ChatAgentDefaults } from '@shared/models/chatAgentDefaults';
import { agentDefaultEffort, agentDefaultModel } from '@shared/models/chatAgentDefaults';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { EFFORT_DEFAULT_ID, resolveEffortSelection } from './efforts';
import { AUTOMATIC_MODEL_ID } from './models';
import {
  readSessionEffort,
  readSessionModel,
  writeSessionEffort,
  writeSessionModel,
} from './sessionPreferenceStore';

/** Recover a known last model for older chats that never saved a renderer preference. */
export function restoreIndexedSessionModels(entries: readonly SessionIndexEntry[]): void {
  for (const entry of entries) {
    if (!entry.archived && entry.model && readSessionModel(entry.sessionId) === null) {
      writeSessionModel(entry.sessionId, entry.model);
    }
  }
}

/** Snapshot inherited defaults once; later picks in other chats cannot change this chat. */
export function captureSessionGenerationPreferences(
  sessionId: string,
  defaults: ChatAgentDefaults
): void {
  if (readSessionModel(sessionId) === null) {
    writeSessionModel(sessionId, agentDefaultModel(defaults) ?? AUTOMATIC_MODEL_ID);
  }
  if (readSessionEffort(sessionId) === null) {
    writeSessionEffort(
      sessionId,
      resolveEffortSelection(null, agentDefaultEffort(defaults)) ?? EFFORT_DEFAULT_ID
    );
  }
}

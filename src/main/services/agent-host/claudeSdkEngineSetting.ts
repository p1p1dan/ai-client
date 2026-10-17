/**
 * Route B, S-1 (decision 1): Main's read of the renderer-owned switch "Claude
 * models use the official Agent SDK" (`claudeSdkEngineEnabled`, on by default).
 *
 * Read when a chat is created, so no watch: a flip only affects chats created
 * after it, and every existing chat keeps the engine it was created on.
 * Renderer-owned and persisted like the other model request settings, so it
 * comes through `readSettingsState` (`promptCacheSettings.ts` explains the unwrap).
 * A developer-mode setting: with developer mode off it reads as the default
 * (`@shared/developerMode`).
 */

import {
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  resolveClaudeSdkEngineEnabled,
} from '@shared/claudeSdkEngine';
import { applyDeveloperModeGate } from '@shared/developerMode';
import { readSettingsState } from '../../ipc/settings';

/** The switch as stored, or the default for an install that never touched it or out of developer mode. */
export function claudeSdkEngineEnabled(
  read: () => Record<string, unknown> = readSettingsState
): boolean {
  return resolveClaudeSdkEngineEnabled(
    applyDeveloperModeGate(read())[CLAUDE_SDK_ENGINE_SETTING_KEY]
  );
}

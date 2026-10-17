import {
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  resolveClaudeSdkEngineEnabled,
} from '@shared/claudeSdkEngine';
import { applyDeveloperModeGate, DEVELOPER_MODE_SETTING_KEY } from '@shared/developerMode';
import type { SettingsState } from './types';

/**
 * S-6 feedback 10: the Agent SDK engine switch in effect, by the rule Main
 * creates a chat by (`agent-host/claudeSdkEngineSetting.ts`), so the composer
 * predicts the engine Main will actually pick.
 */
export function effectiveClaudeSdkEngineEnabled(
  state: Pick<SettingsState, 'developerModeEnabled' | 'claudeSdkEngineEnabled'>
): boolean {
  const gated = applyDeveloperModeGate({
    [DEVELOPER_MODE_SETTING_KEY]: state.developerModeEnabled,
    [CLAUDE_SDK_ENGINE_SETTING_KEY]: state.claudeSdkEngineEnabled,
  });
  return resolveClaudeSdkEngineEnabled(gated[CLAUDE_SDK_ENGINE_SETTING_KEY]);
}

import { sanitizeChatAgentDefaults } from '@shared/models/chatAgentDefaults';
import type { SettingsState, TerminalKeybinding, XtermKeybindings } from './types';

function sanitizeRemoteProfiles(
  profiles: SettingsState['remoteSettings']['profiles'] | undefined
): SettingsState['remoteSettings']['profiles'] | undefined {
  if (!profiles) {
    return undefined;
  }

  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    sshTarget: profile.sshTarget,
    runtimeInstallDir: profile.runtimeInstallDir,
    helperInstallDir: profile.helperInstallDir,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }));
}

/**
 * Helper functions for sanitizing persisted values
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(min, parsed));
    }
  }
  return fallback;
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

const LEGACY_AI_FEATURE_KEYS = [
  'commitMessageGenerator',
  'codeReview',
  'branchNameGenerator',
  'todoPolish',
] as const;

export function sanitizeLegacyAiSettings(
  persisted: Partial<SettingsState>
): Partial<SettingsState> {
  const next = { ...(persisted as Record<string, unknown>) };
  delete next.agentSettings;
  delete next.agentDetectionStatus;
  delete next.customAgents;
  delete next.hapiSettings;
  for (const key of LEGACY_AI_FEATURE_KEYS) {
    const raw = next[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = { ...(raw as Record<string, unknown>) };
    delete value.provider;
    delete value.reasoningEffort;
    delete value.bare;
    delete value.claudeEffort;
    // Bare legacy model ids have no stable Pi identity. Only retain explicit
    // provider/model references already written by a Pi-aware build.
    if (typeof value.model !== 'string' || !value.model.includes('/')) delete value.model;
    next[key] = value;
  }
  return next as Partial<SettingsState>;
}

/**
 * Migrate persisted state to current state format
 * Handles version upgrades, field sanitization, and legacy data migration
 */
export function migrateSettings(
  persistedState: Partial<SettingsState> | undefined,
  currentState: SettingsState
): SettingsState {
  if (!persistedState) {
    return currentState;
  }

  const persisted = persistedState;

  // Migrate a persisted 'system' theme to 'light': 'system' was the unchosen
  // default, never an explicit user pick — the product default moved to
  // light. Users who explicitly want system/dark can re-pick in Settings.
  const migratedTheme = persisted.theme === 'system' ? 'light' : persisted.theme;

  // Sanitize background image settings
  const sanitizedBackgroundOpacity = clampNumber(
    persisted.backgroundOpacity,
    0,
    1,
    currentState.backgroundOpacity
  );
  const sanitizedBackgroundBlur = clampNumber(
    persisted.backgroundBlur,
    0,
    20,
    currentState.backgroundBlur
  );
  const sanitizedBackgroundBrightness = clampNumber(
    persisted.backgroundBrightness,
    0,
    2,
    currentState.backgroundBrightness
  );
  const sanitizedBackgroundSaturation = clampNumber(
    persisted.backgroundSaturation,
    0,
    2,
    currentState.backgroundSaturation
  );
  const sanitizedBackgroundImageEnabled = sanitizeBoolean(
    persisted.backgroundImageEnabled,
    currentState.backgroundImageEnabled
  );
  const sanitizedBackgroundImagePath = sanitizeString(
    persisted.backgroundImagePath,
    currentState.backgroundImagePath
  );
  const sanitizedBackgroundUrlPath = sanitizeString(
    persisted.backgroundUrlPath,
    currentState.backgroundUrlPath
  );
  const sanitizedBackgroundFolderPath = sanitizeString(
    persisted.backgroundFolderPath,
    currentState.backgroundFolderPath
  );

  // Validate background source type
  const sourceTypes: SettingsState['backgroundSourceType'][] = ['file', 'folder', 'url'];
  const sanitizedBackgroundSourceType =
    persisted.backgroundSourceType && sourceTypes.includes(persisted.backgroundSourceType)
      ? persisted.backgroundSourceType
      : currentState.backgroundSourceType;

  // Migrate legacy backgroundUrlPath from backgroundImagePath
  const migratedBackgroundUrlPath =
    sanitizedBackgroundUrlPath ||
    (sanitizedBackgroundSourceType === 'url' ? sanitizedBackgroundImagePath : '');

  const sanitizedBackgroundRandomEnabled = sanitizeBoolean(
    persisted.backgroundRandomEnabled,
    currentState.backgroundRandomEnabled
  );
  const sanitizedBackgroundRandomInterval = clampNumber(
    persisted.backgroundRandomInterval,
    5,
    86400,
    currentState.backgroundRandomInterval
  );

  // Validate background size mode
  const sizeModes: SettingsState['backgroundSizeMode'][] = ['cover', 'contain', 'repeat', 'center'];
  const sanitizedBackgroundSizeMode =
    persisted.backgroundSizeMode && sizeModes.includes(persisted.backgroundSizeMode)
      ? persisted.backgroundSizeMode
      : currentState.backgroundSizeMode;

  // Migrate legacy 'canvas' renderer to 'webgl' (canvas support was removed)
  const terminalRenderer =
    (persisted.terminalRenderer as string) === 'canvas' ? 'webgl' : persisted.terminalRenderer;

  // Migrate xterm keybindings from legacy formats
  const migratedXtermKeybindings = migrateXtermKeybindings(persisted, currentState);

  // Migrate Claude Code integration settings
  const migratedClaudeCodeIntegration = migrateClaudeCodeIntegration(persisted, currentState);

  const sanitizedPersisted = sanitizeLegacyAiSettings(persisted);

  return {
    ...currentState,
    ...sanitizedPersisted,
    // Override with migrated/sanitized values
    ...(migratedTheme && { theme: migratedTheme }),
    ...(terminalRenderer && { terminalRenderer }),
    presentationMode: persisted.presentationMode === 'tui' ? 'tui' : 'gui',
    xtermKeybindings: migratedXtermKeybindings,
    mainTabKeybindings: {
      ...currentState.mainTabKeybindings,
      ...persisted.mainTabKeybindings,
    },
    sourceControlKeybindings: {
      ...currentState.sourceControlKeybindings,
      ...persisted.sourceControlKeybindings,
    },
    searchKeybindings: {
      ...currentState.searchKeybindings,
      ...persisted.searchKeybindings,
    },
    editorKeybindings: {
      ...currentState.editorKeybindings,
      ...persisted.editorKeybindings,
    },
    globalKeybindings: {
      ...currentState.globalKeybindings,
      ...persisted.globalKeybindings,
    },
    workspaceKeybindings: {
      ...currentState.workspaceKeybindings,
      ...persisted.workspaceKeybindings,
    },
    backgroundImageEnabled: sanitizedBackgroundImageEnabled,
    backgroundImagePath: sanitizedBackgroundImagePath,
    backgroundUrlPath: migratedBackgroundUrlPath,
    backgroundFolderPath: sanitizedBackgroundFolderPath,
    backgroundSourceType: sanitizedBackgroundSourceType,
    backgroundRandomEnabled: sanitizedBackgroundRandomEnabled,
    backgroundRandomInterval: sanitizedBackgroundRandomInterval,
    backgroundOpacity: sanitizedBackgroundOpacity,
    backgroundBlur: sanitizedBackgroundBlur,
    backgroundBrightness: sanitizedBackgroundBrightness,
    backgroundSaturation: sanitizedBackgroundSaturation,
    backgroundSizeMode: sanitizedBackgroundSizeMode,
    editorSettings: {
      ...currentState.editorSettings,
      ...persisted.editorSettings,
    },
    claudeCodeIntegration: migratedClaudeCodeIntegration,
    commitMessageGenerator: {
      ...currentState.commitMessageGenerator,
      ...sanitizedPersisted.commitMessageGenerator,
    },
    codeReview: {
      ...currentState.codeReview,
      ...sanitizedPersisted.codeReview,
    },
    branchNameGenerator: {
      ...currentState.branchNameGenerator,
      ...sanitizedPersisted.branchNameGenerator,
    },
    todoPolish: {
      ...currentState.todoPolish,
      ...sanitizedPersisted.todoPolish,
    },
    remoteSettings: {
      ...currentState.remoteSettings,
      ...persisted.remoteSettings,
      profiles:
        sanitizeRemoteProfiles(persisted.remoteSettings?.profiles) ??
        currentState.remoteSettings.profiles,
    },
    proxySettings: {
      ...currentState.proxySettings,
      ...persisted.proxySettings,
    },
    quickTerminal: {
      ...currentState.quickTerminal,
      ...persisted.quickTerminal,
    },
    // D48 S2 §4.3: replaced wholesale rather than shallow-merged. The record's
    // shape is nested (`byAgent[agent].model`), so `{...current, ...persisted}`
    // would keep a `byAgent` from one side and a `lastAgent` from the other; and
    // it is the ONE field here whose values name an agent, so an unknown slug
    // written by a newer build has to be dropped rather than spread through.
    chatAgentDefaults: sanitizeChatAgentDefaults(persisted.chatAgentDefaults),
  };
}

/**
 * Migrate xterm keybindings from legacy formats
 * TODO: Remove this migration block after v1.0 release
 */
function migrateXtermKeybindings(
  persisted: Partial<SettingsState>,
  currentState: SettingsState
): XtermKeybindings {
  // If user has already saved xtermKeybindings, use it directly (no legacy migration)
  if (persisted.xtermKeybindings) {
    return {
      ...currentState.xtermKeybindings,
      ...persisted.xtermKeybindings,
    };
  }

  // Legacy migration: only runs when xtermKeybindings doesn't exist yet
  const filterDefined = <T extends object>(obj: T): Partial<T> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

  type LegacyAgentKeybindings = {
    newSession?: TerminalKeybinding;
    closeSession?: TerminalKeybinding;
    nextSession?: TerminalKeybinding;
    prevSession?: TerminalKeybinding;
  };

  type LegacyPaneKeybindings = {
    split?: TerminalKeybinding;
    merge?: TerminalKeybinding;
  };

  const legacy = persisted as {
    terminalKeybindings?: Partial<XtermKeybindings>;
    agentKeybindings?: LegacyAgentKeybindings;
    terminalPaneKeybindings?: LegacyPaneKeybindings;
  };

  return {
    ...currentState.xtermKeybindings,
    ...(legacy.terminalKeybindings &&
      filterDefined({
        newTab: legacy.terminalKeybindings.newTab,
        closeTab: legacy.terminalKeybindings.closeTab,
        nextTab: legacy.terminalKeybindings.nextTab,
        prevTab: legacy.terminalKeybindings.prevTab,
        clear: legacy.terminalKeybindings.clear,
      })),
    ...(legacy.agentKeybindings &&
      filterDefined({
        newTab: legacy.agentKeybindings.newSession,
        closeTab: legacy.agentKeybindings.closeSession,
        nextTab: legacy.agentKeybindings.nextSession,
        prevTab: legacy.agentKeybindings.prevSession,
      })),
    ...(legacy.terminalPaneKeybindings &&
      filterDefined({
        split: legacy.terminalPaneKeybindings.split,
        merge: legacy.terminalPaneKeybindings.merge,
      })),
  };
}

/**
 * Migrate Claude Code integration settings
 */
function migrateClaudeCodeIntegration(
  persisted: Partial<SettingsState>,
  currentState: SettingsState
): SettingsState['claudeCodeIntegration'] {
  const merged = {
    ...currentState.claudeCodeIntegration,
    ...persisted.claudeCodeIntegration,
    statusLineFields: {
      ...currentState.claudeCodeIntegration.statusLineFields,
      ...persisted.claudeCodeIntegration?.statusLineFields,
    },
  };

  // Migrate legacy boolean enhancedInputAutoPopup to new enum value
  const legacyAutoPopup = persisted.claudeCodeIntegration?.enhancedInputAutoPopup;
  if (typeof legacyAutoPopup === 'boolean') {
    merged.enhancedInputAutoPopup = legacyAutoPopup ? 'hideWhileRunning' : 'manual';
  }

  // Fix inconsistent state: hideWhileRunning requires stopHookEnabled
  if (merged.enhancedInputAutoPopup === 'hideWhileRunning' && !merged.stopHookEnabled) {
    merged.enhancedInputAutoPopup = 'always';
  }

  return merged;
}

/**
 * Clean up legacy fields from persisted state
 * TODO: Remove this function after v1.0 release
 */
export async function cleanupLegacyFields(): Promise<void> {
  const data = await window.electronAPI.settings.read();
  if (data && typeof data === 'object') {
    const settingsData = data as Record<string, unknown>;
    const aiclientSettings = settingsData['aiclient-settings'] as
      | { state?: Record<string, unknown> }
      | undefined;

    if (aiclientSettings?.state) {
      const legacyFields = ['terminalKeybindings', 'agentKeybindings', 'terminalPaneKeybindings'];
      let changed = legacyFields.some((field) => field in aiclientSettings.state!);

      for (const field of legacyFields) {
        delete aiclientSettings.state[field];
      }

      const sanitized = sanitizeLegacyAiSettings(
        aiclientSettings.state as Partial<SettingsState>
      ) as Record<string, unknown>;
      for (const key of LEGACY_AI_FEATURE_KEYS) {
        const before = aiclientSettings.state[key];
        const after = sanitized[key];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          aiclientSettings.state[key] = after;
          changed = true;
        }
      }

      if (changed) {
        await window.electronAPI.settings.write(settingsData);
      }
    }
  }
}

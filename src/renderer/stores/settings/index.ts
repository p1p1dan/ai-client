import type { Locale } from '@shared/i18n';
import { normalizeLocale } from '@shared/i18n';
import { EMPTY_CHAT_AGENT_DEFAULTS } from '@shared/models/chatAgentDefaults';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  applyTerminalThemeToApp,
  clearTerminalThemeFromApp,
  isTerminalThemeDark,
} from '@/lib/ghosttyTheme';
import { updateRendererLogging } from '@/utils/logging';
import {
  defaultBranchNameGeneratorSettings,
  defaultClaudeCodeIntegrationSettings,
  defaultCodeReviewSettings,
  defaultCommitMessageGeneratorSettings,
  defaultEditorKeybindings,
  defaultEditorSettings,
  defaultFileTreeDisplayMode,
  defaultGitCloneSettings,
  defaultGlobalKeybindings,
  defaultLayoutMode,
  defaultMainTabKeybindings,
  defaultProxySettings,
  defaultQuickTerminalSettings,
  defaultRemoteSettings,
  defaultRepositoryListDisplayMode,
  defaultSearchKeybindings,
  defaultSourceControlKeybindings,
  defaultTodoEnabled,
  defaultTodoPolishSettings,
  defaultWorkspaceKeybindings,
  defaultXtermKeybindings,
  getDefaultLocale,
  getDefaultShellConfig,
} from './defaults';
import { cleanupLegacyFields, migrateSettings } from './migration';
import { readPresentationMode, writePresentationMode } from './presentationModeMirror';
import { readShellPreference, writeShellPreference } from './shellPreferenceMirror';
import { electronStorage } from './storage';
import type {
  BackgroundSizeMode,
  BackgroundSourceType,
  FontWeight,
  SettingsState,
  Theme,
} from './types';

/**
 * D48 S2 §4.3 — whether the async settings rehydrate has landed.
 *
 * `electronStorage` reads and writes through `window.electronAPI.settings`, so
 * every launch has a window where this store holds `defaults.ts` values that
 * nobody chose. Two things must not happen in that window: believing a default
 * is a user preference, and PERSISTING it back over the real one. Callers gate
 * both halves on this flag (`resolveInitialDraftAgent` / `canPersistLastAgent`,
 * truth-tabled in `shared/models/chatAgentDefaults.ts`).
 *
 * Reactive rather than a bare `persist.hasHydrated()` call: hydration finishes
 * asynchronously, so a component that read it once at mount would keep the
 * pre-hydration answer for the rest of its life.
 */
export function useSettingsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useSettingsStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return undefined;
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => setHydrated(true));
    // A rehydrate that completed between the initial read and this subscription
    // would otherwise never be observed.
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true);
    return unsubscribe;
  }, [hydrated]);
  return hydrated;
}

export * from './defaults';
// Re-export types and defaults for external use
export * from './types';

/*
 * Terminal font settings intentionally do NOT touch app CSS variables.
 * xterm reads fontFamily/fontSize as JS options (see useXterm) and Monaco reads
 * editorSettings, so neither consumes a CSS variable. The former
 * applyTerminalFont() wrote --font-family-mono and --font-size-base onto
 * documentElement, which had the side effect of rescaling the entire UI (every
 * rem) and repointing every font-mono utility whenever the terminal font
 * changed. The UI font stack now comes from @theme in styles/globals.css.
 */

// Apply app theme (dark/light mode)
function applyAppTheme(theme: Theme, terminalTheme: string): void {
  const root = document.documentElement;
  let isDark: boolean;

  switch (theme) {
    case 'light':
      isDark = false;
      break;
    case 'dark':
      isDark = true;
      break;
    case 'system':
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      break;
    case 'sync-terminal':
      isDark = isTerminalThemeDark(terminalTheme);
      break;
  }

  root.classList.toggle('dark', isDark);
}

// Apply initial settings on app load
function applyInitialSettings(state: {
  theme: Theme;
  terminalTheme: string;
  language: Locale;
}): void {
  if (state.theme === 'sync-terminal') {
    applyTerminalThemeToApp(state.terminalTheme, true);
  } else {
    applyAppTheme(state.theme, state.terminalTheme);
  }
  const resolvedLanguage = normalizeLocale(state.language);
  document.documentElement.lang = resolvedLanguage === 'zh' ? 'zh-CN' : 'en';
  window.electronAPI.app.setLanguage(resolvedLanguage);
}

// Get initial state values
export function getInitialState() {
  return {
    // UI Settings
    theme: 'light' as Theme,
    layoutMode: defaultLayoutMode,
    fileTreeDisplayMode: defaultFileTreeDisplayMode,
    repositoryListDisplayMode: defaultRepositoryListDisplayMode,
    language: getDefaultLocale(),
    fontSize: 14,
    fontFamily: 'Inter',

    // Terminal Settings
    terminalFontSize: 16,
    terminalFontFamily: 'ui-monospace, SF Mono, Menlo, Monaco, Consolas, monospace',
    terminalFontWeight: 'normal' as FontWeight,
    terminalFontWeightBold: '500' as FontWeight,
    terminalTheme: 'Dracula',
    terminalRenderer: 'dom' as const,
    terminalScrollback: 10000,
    terminalOptionIsMeta: true,
    copyOnSelection: false,

    // Keybindings
    xtermKeybindings: defaultXtermKeybindings,
    mainTabKeybindings: defaultMainTabKeybindings,
    sourceControlKeybindings: defaultSourceControlKeybindings,
    searchKeybindings: defaultSearchKeybindings,
    editorKeybindings: defaultEditorKeybindings,
    globalKeybindings: defaultGlobalKeybindings,
    workspaceKeybindings: defaultWorkspaceKeybindings,

    // Editor Settings
    editorSettings: defaultEditorSettings,

    // Terminal session settings
    shellConfig: getDefaultShellConfig(),
    agentNotificationEnabled: true,
    agentNotificationDelay: 5,
    agentNotificationEnterDelay: 5,
    // D48 S2 §4.3: empty means "no memory yet" — a new install starts every
    // draft on the legacy binding and every model on `Automatic`.
    chatAgentDefaults: EMPTY_CHAT_AGENT_DEFAULTS,

    // Claude Code Integration
    claudeCodeIntegration: defaultClaudeCodeIntegrationSettings,

    // AI Features
    commitMessageGenerator: defaultCommitMessageGeneratorSettings,
    codeReview: defaultCodeReviewSettings,
    branchNameGenerator: defaultBranchNameGeneratorSettings,
    todoPolish: defaultTodoPolishSettings,

    // App Settings
    autoUpdateEnabled: true,
    remoteSettings: defaultRemoteSettings,
    defaultWorktreePath: '',
    proxySettings: defaultProxySettings,
    autoCreateSessionOnActivate: false,

    // Git Auto Operations
    gitAutoFetchEnabled: true,

    // Git Clone Settings
    gitClone: defaultGitCloneSettings,

    // Beta features
    todoEnabled: defaultTodoEnabled,
    glowEffectEnabled: false,
    // T-16: on by default (`DEFAULT_USE_OPENCHAMBER_SHELL`). Until T-16 the
    // value was irrelevant — Root.tsx force-wrote `true` on every launch — so
    // every existing profile already persists `true` and flipping the default
    // changes nothing for them. It is a fresh profile that would otherwise land
    // in the legacy tab shell, which is the fallback, not the product.
    // The read goes through the synchronous mirror so the first frame already
    // shows the chosen shell; `electronStorage` rehydration is async.
    useOpenChamberShell: readShellPreference(),
    temporaryWorkspaceEnabled: false,
    defaultTemporaryPath: '',
    autoCreateSessionOnTempActivate: false,

    // Background image defaults
    backgroundImageEnabled: false,
    backgroundImagePath: '',
    backgroundUrlPath: '',
    backgroundFolderPath: '',
    backgroundSourceType: 'file' as BackgroundSourceType,
    backgroundRandomEnabled: false,
    backgroundRandomInterval: 300,
    backgroundOpacity: 0.85,
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    backgroundSizeMode: 'cover' as BackgroundSizeMode,
    _backgroundRefreshKey: 0,

    // Settings display mode
    settingsDisplayMode: 'tab' as const,
    settingsModalPosition: null,
    presentationMode: readPresentationMode(),

    // Terminal theme favorites
    favoriteTerminalThemes: [] as string[],

    // Quick Terminal defaults
    quickTerminal: defaultQuickTerminalSettings,

    // Web Inspector defaults
    webInspectorEnabled: false,

    // Hide Groups default
    hideGroups: false,
    hiddenOpenInApps: [] as string[],
    openInMenuFilterEnabled: false,

    // File Tree defaults
    fileTreeAutoReveal: true, // Auto-reveal active file in file tree by default (like VSCode)

    // Logging defaults
    loggingEnabled: false,
    logLevel: 'info' as const,
    logRetentionDays: 7,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...getInitialState(),

      // UI Setters
      setTheme: (theme) => {
        const terminalTheme = get().terminalTheme;
        if (theme === 'sync-terminal') {
          applyTerminalThemeToApp(terminalTheme, true);
        } else {
          clearTerminalThemeFromApp();
          applyAppTheme(theme, terminalTheme);
        }
        set({ theme });
      },

      setLayoutMode: (layoutMode) => set({ layoutMode }),

      setFileTreeDisplayMode: (fileTreeDisplayMode) => set({ fileTreeDisplayMode }),

      setRepositoryListDisplayMode: (repositoryListDisplayMode) =>
        set({ repositoryListDisplayMode }),

      setLanguage: (language) => {
        document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
        window.electronAPI.app.setLanguage(language);
        set({ language });
      },

      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setPresentationMode: (presentationMode) => {
        writePresentationMode(presentationMode);
        set({ presentationMode });
      },

      // Terminal Setters - xterm picks these up through its own store subscription
      setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
      setTerminalFontFamily: (terminalFontFamily) => set({ terminalFontFamily }),

      setTerminalFontWeight: (terminalFontWeight) => set({ terminalFontWeight }),
      setTerminalFontWeightBold: (terminalFontWeightBold) => set({ terminalFontWeightBold }),

      setTerminalTheme: (terminalTheme) => {
        const currentTheme = get().theme;
        if (currentTheme === 'sync-terminal') {
          applyTerminalThemeToApp(terminalTheme, true);
        }
        set({ terminalTheme });
      },

      setTerminalRenderer: (terminalRenderer) => set({ terminalRenderer }),
      setTerminalScrollback: (terminalScrollback) => set({ terminalScrollback }),
      setTerminalOptionIsMeta: (terminalOptionIsMeta) => set({ terminalOptionIsMeta }),
      setCopyOnSelection: (copyOnSelection) => set({ copyOnSelection }),

      // Keybinding Setters
      setXtermKeybindings: (xtermKeybindings) => set({ xtermKeybindings }),
      setMainTabKeybindings: (mainTabKeybindings) => set({ mainTabKeybindings }),
      setSourceControlKeybindings: (sourceControlKeybindings) => set({ sourceControlKeybindings }),
      setSearchKeybindings: (searchKeybindings) => set({ searchKeybindings }),
      setEditorKeybindings: (editorKeybindings) => set({ editorKeybindings }),
      setGlobalKeybindings: (globalKeybindings) => set({ globalKeybindings }),
      setWorkspaceKeybindings: (workspaceKeybindings) => set({ workspaceKeybindings }),

      // Editor Setters
      setEditorSettings: (settings) =>
        set((state) => ({
          editorSettings: { ...state.editorSettings, ...settings },
        })),

      // Terminal session setters
      setShellConfig: (shellConfig) => set({ shellConfig }),
      setAgentNotificationEnabled: (agentNotificationEnabled) => set({ agentNotificationEnabled }),
      setAgentNotificationDelay: (agentNotificationDelay) => set({ agentNotificationDelay }),
      setAgentNotificationEnterDelay: (agentNotificationEnterDelay) =>
        set({ agentNotificationEnterDelay }),

      setChatAgentDefaults: (chatAgentDefaults) => set({ chatAgentDefaults }),

      // Claude Code Integration Setters
      setClaudeCodeIntegration: (settings) =>
        set((state) => ({
          claudeCodeIntegration: { ...state.claudeCodeIntegration, ...settings },
        })),

      // AI Feature Setters
      setCommitMessageGenerator: (settings) =>
        set((state) => ({
          commitMessageGenerator: { ...state.commitMessageGenerator, ...settings },
        })),

      setCodeReview: (settings) =>
        set((state) => ({
          codeReview: { ...state.codeReview, ...settings },
        })),

      setBranchNameGenerator: (settings) =>
        set((state) => ({
          branchNameGenerator: { ...state.branchNameGenerator, ...settings },
        })),

      setTodoPolish: (settings) =>
        set((state) => ({
          todoPolish: { ...state.todoPolish, ...settings },
        })),

      // App Setters
      setAutoUpdateEnabled: (autoUpdateEnabled) => {
        set({ autoUpdateEnabled });
        window.electronAPI.updater.setAutoUpdateEnabled(autoUpdateEnabled);
      },

      setRemoteProfiles: (profiles) =>
        set((state) => ({
          remoteSettings: { ...state.remoteSettings, profiles },
        })),

      upsertRemoteProfile: (profile) =>
        set((state) => {
          const index = state.remoteSettings.profiles.findIndex((item) => item.id === profile.id);
          const profiles =
            index >= 0
              ? state.remoteSettings.profiles.map((item) =>
                  item.id === profile.id ? profile : item
                )
              : [...state.remoteSettings.profiles, profile];
          return {
            remoteSettings: { ...state.remoteSettings, profiles },
          };
        }),

      removeRemoteProfile: (profileId) =>
        set((state) => ({
          remoteSettings: {
            ...state.remoteSettings,
            profiles: state.remoteSettings.profiles.filter((profile) => profile.id !== profileId),
          },
        })),

      setDefaultWorktreePath: (defaultWorktreePath) => set({ defaultWorktreePath }),

      setProxySettings: (settings) => {
        set((state) => ({
          proxySettings: { ...state.proxySettings, ...settings },
        }));
        const newSettings = { ...get().proxySettings, ...settings };
        window.electronAPI.app.setProxy(newSettings);
      },

      setAutoCreateSessionOnActivate: (autoCreateSessionOnActivate) =>
        set({ autoCreateSessionOnActivate }),

      setGitAutoFetchEnabled: (gitAutoFetchEnabled) => {
        set({ gitAutoFetchEnabled });
        window.electronAPI.git.setAutoFetchEnabled(gitAutoFetchEnabled);
      },

      // Git Clone Setters
      setGitClone: (settings) =>
        set((state) => ({
          gitClone: { ...state.gitClone, ...settings },
        })),

      addHostMapping: (mapping) =>
        set((state) => ({
          gitClone: {
            ...state.gitClone,
            hostMappings: [...state.gitClone.hostMappings, mapping],
          },
        })),

      removeHostMapping: (pattern) =>
        set((state) => ({
          gitClone: {
            ...state.gitClone,
            hostMappings: state.gitClone.hostMappings.filter((m) => m.pattern !== pattern),
          },
        })),

      updateHostMapping: (oldPattern, updates) =>
        set((state) => ({
          gitClone: {
            ...state.gitClone,
            hostMappings: state.gitClone.hostMappings.map((m) =>
              m.pattern === oldPattern ? { ...m, ...updates } : m
            ),
          },
        })),

      // Beta Feature Setters
      setTodoEnabled: (todoEnabled) => set({ todoEnabled }),
      setGlowEffectEnabled: (glowEffectEnabled) => set({ glowEffectEnabled }),
      setUseOpenChamberShell: (useOpenChamberShell) => {
        // Mirror first: the persisted write is async, and this value decides
        // what the next launch paints before rehydration lands (T-16).
        writeShellPreference(useOpenChamberShell);
        set({ useOpenChamberShell });
      },
      setTemporaryWorkspaceEnabled: (temporaryWorkspaceEnabled) =>
        set({ temporaryWorkspaceEnabled }),
      setDefaultTemporaryPath: (defaultTemporaryPath) => set({ defaultTemporaryPath }),
      setAutoCreateSessionOnTempActivate: (autoCreateSessionOnTempActivate) =>
        set({ autoCreateSessionOnTempActivate }),

      // Background Image Setters
      setBackgroundImageEnabled: (backgroundImageEnabled) => set({ backgroundImageEnabled }),
      setBackgroundImagePath: (backgroundImagePath) => set({ backgroundImagePath }),
      setBackgroundUrlPath: (backgroundUrlPath) => set({ backgroundUrlPath }),
      setBackgroundFolderPath: (backgroundFolderPath) => set({ backgroundFolderPath }),
      setBackgroundSourceType: (backgroundSourceType) => set({ backgroundSourceType }),
      setBackgroundRandomEnabled: (backgroundRandomEnabled) => set({ backgroundRandomEnabled }),

      setBackgroundRandomInterval: (backgroundRandomInterval) => {
        const safeValue = Number.isFinite(backgroundRandomInterval)
          ? Math.max(5, Math.min(86400, backgroundRandomInterval))
          : 300;
        set({ backgroundRandomInterval: safeValue });
      },

      setBackgroundOpacity: (backgroundOpacity) => {
        const safeValue = Number.isFinite(backgroundOpacity)
          ? backgroundOpacity
          : get().backgroundOpacity;
        const clamped = Math.min(1, Math.max(0, safeValue));
        set({ backgroundOpacity: clamped });
      },

      setBackgroundBlur: (backgroundBlur) => {
        const safeValue = Number.isFinite(backgroundBlur) ? backgroundBlur : get().backgroundBlur;
        const clamped = Math.min(20, Math.max(0, safeValue));
        set({ backgroundBlur: clamped });
      },

      setBackgroundBrightness: (backgroundBrightness) => {
        const safeValue = Number.isFinite(backgroundBrightness)
          ? backgroundBrightness
          : get().backgroundBrightness;
        const clamped = Math.min(2, Math.max(0, safeValue));
        set({ backgroundBrightness: clamped });
      },

      setBackgroundSaturation: (backgroundSaturation) => {
        const safeValue = Number.isFinite(backgroundSaturation)
          ? backgroundSaturation
          : get().backgroundSaturation;
        const clamped = Math.min(2, Math.max(0, safeValue));
        set({ backgroundSaturation: clamped });
      },

      setBackgroundSizeMode: (backgroundSizeMode) => set({ backgroundSizeMode }),

      triggerBackgroundRefresh: () =>
        set((state) => ({ _backgroundRefreshKey: state._backgroundRefreshKey + 1 })),

      // Settings Display Setters
      setSettingsDisplayMode: (mode) => set({ settingsDisplayMode: mode }),
      setSettingsModalPosition: (position) => set({ settingsModalPosition: position }),

      // Terminal Theme Favorites Setters
      addFavoriteTerminalTheme: (theme) =>
        set((state) => ({
          favoriteTerminalThemes: state.favoriteTerminalThemes.includes(theme)
            ? state.favoriteTerminalThemes
            : [...state.favoriteTerminalThemes, theme],
        })),

      removeFavoriteTerminalTheme: (theme) =>
        set((state) => ({
          favoriteTerminalThemes: state.favoriteTerminalThemes.filter((t) => t !== theme),
        })),

      toggleFavoriteTerminalTheme: (theme) =>
        set((state) => ({
          favoriteTerminalThemes: state.favoriteTerminalThemes.includes(theme)
            ? state.favoriteTerminalThemes.filter((t) => t !== theme)
            : [...state.favoriteTerminalThemes, theme],
        })),

      // Quick Terminal Setters
      setQuickTerminalEnabled: (enabled) =>
        set((state) => ({
          quickTerminal: { ...state.quickTerminal, enabled },
        })),

      setQuickTerminalButtonPosition: (position) =>
        set((state) => ({
          quickTerminal: { ...state.quickTerminal, buttonPosition: position },
        })),

      setQuickTerminalModalPosition: (position) =>
        set((state) => ({
          quickTerminal: { ...state.quickTerminal, modalPosition: position },
        })),

      setQuickTerminalModalSize: (size) =>
        set((state) => ({
          quickTerminal: { ...state.quickTerminal, modalSize: size },
        })),

      setQuickTerminalOpen: (open) =>
        set((state) => ({
          quickTerminal: { ...state.quickTerminal, isOpen: open },
        })),

      // Web Inspector Setter
      setWebInspectorEnabled: async (enabled) => {
        set({ webInspectorEnabled: enabled });
        if (enabled) {
          const result = await window.electronAPI.webInspector.start();
          if (!result.success) {
            console.error('[WebInspector] Failed to start:', result.error);
            set({ webInspectorEnabled: false });
          }
        } else {
          await window.electronAPI.webInspector.stop();
        }
      },

      // Other Setters
      setHideGroups: (hideGroups) => set({ hideGroups }),
      toggleHiddenOpenInApp: (bundleId) =>
        set((state) => ({
          hiddenOpenInApps: state.hiddenOpenInApps.includes(bundleId)
            ? state.hiddenOpenInApps.filter((id) => id !== bundleId)
            : [...state.hiddenOpenInApps, bundleId],
        })),
      setOpenInMenuFilterEnabled: (enabled) => set({ openInMenuFilterEnabled: enabled }),

      // File Tree Setters
      setFileTreeAutoReveal: (fileTreeAutoReveal) => set({ fileTreeAutoReveal }),

      // Logging Setters
      setLoggingEnabled: (loggingEnabled) => {
        const { logLevel } = get();
        set({ loggingEnabled });
        window.electronAPI.log.updateConfig({ enabled: loggingEnabled, level: logLevel });
        updateRendererLogging(loggingEnabled, logLevel);
      },

      setLogLevel: (logLevel) => {
        const { loggingEnabled } = get();
        set({ logLevel });
        window.electronAPI.log.updateConfig({ enabled: loggingEnabled, level: logLevel });
        updateRendererLogging(loggingEnabled, logLevel);
      },

      setLogRetentionDays: (logRetentionDays) => {
        const clampedDays = Math.min(30, Math.max(1, Math.floor(logRetentionDays)));
        set({ logRetentionDays: clampedDays });
      },
    }),
    {
      name: 'aiclient-settings',
      storage: createJSONStorage(() => electronStorage),
      // Exclude transient fields from persistence
      partialize: (state) => {
        const { _backgroundRefreshKey, ...rest } = state;
        return rest as SettingsState;
      },
      // Deep merge nested objects to preserve new default fields when upgrading
      merge: (persistedState, currentState) => {
        return migrateSettings(persistedState as Partial<SettingsState>, currentState);
      },
      onRehydrateStorage: () => (state) => {
        const effectiveState = state ?? useSettingsStore.getState();
        applyInitialSettings(effectiveState);

        // T-16: settings.json stays the authority — re-point the synchronous
        // mirror at the hydrated value so an out-of-band edit (or a cleared
        // localStorage) converges after one launch instead of fighting it.
        writeShellPreference(effectiveState.useOpenChamberShell);
        writePresentationMode(effectiveState.presentationMode);

        // Sync renderer logging configuration after settings are loaded
        updateRendererLogging(effectiveState.loggingEnabled, effectiveState.logLevel);

        // Listen for system theme changes
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', () => {
          const currentState = useSettingsStore.getState();
          if (currentState.theme === 'system') {
            applyAppTheme('system', currentState.terminalTheme);
          }
        });

        if (state) {
          // Apply proxy settings
          if (state.proxySettings) {
            window.electronAPI.app.setProxy(state.proxySettings);
          }

          // Auto-start Web Inspector server if it was enabled
          if (state.webInspectorEnabled) {
            window.electronAPI.webInspector.start().catch((error) => {
              console.error('[WebInspector] Failed to auto-start:', error);
            });
          }

          // Sync git auto-fetch setting to main process
          if (state.gitAutoFetchEnabled) {
            window.electronAPI.git.setAutoFetchEnabled(true);
          }

          // Clean up legacy fields (async)
          cleanupLegacyFields().catch((err) => {
            console.warn('Failed to cleanup legacy fields:', err);
          });

          // Auto-detect best shell on Windows for new users
          const shellAutoDetectKey = 'aiclient-shell-auto-detected';
          const executionPlatform = window.electronAPI?.env?.platform;
          if (executionPlatform === 'win32' && !localStorage.getItem(shellAutoDetectKey)) {
            localStorage.setItem(shellAutoDetectKey, 'true');
            window.electronAPI.shell
              .detect()
              .then((shells) => {
                const ps7 = shells.find((s) => s.id === 'powershell7' && s.available);
                if (ps7) {
                  useSettingsStore.getState().setShellConfig({ shellType: 'powershell7' });
                }
              })
              .catch((err) => {
                console.warn('Shell auto-detection failed:', err);
              });
          }
        }
      },
    }
  )
);

export type AppCloseRequestReason = 'quit-app' | 'replace-window';

export interface AppCloseRequestPayload {
  requestId: string;
  reason: AppCloseRequestReason;
}

export const IPC_CHANNELS = {
  // Git
  GIT_STATUS: 'git:status',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_FETCH: 'git:fetch',
  GIT_BRANCH_LIST: 'git:branch:list',
  GIT_BRANCH_CREATE: 'git:branch:create',
  GIT_BRANCH_CHECKOUT: 'git:branch:checkout',
  GIT_LOG: 'git:log',
  GIT_DIFF: 'git:diff',
  GIT_INIT: 'git:init',
  GIT_FILE_CHANGES: 'git:file-changes',
  GIT_FILE_DIFF: 'git:file-diff',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_DISCARD: 'git:discard',
  GIT_COMMIT_SHOW: 'git:commit:show',
  GIT_COMMIT_FILES: 'git:commit:files',
  GIT_COMMIT_DIFF: 'git:commit:diff',
  GIT_DIFF_STATS: 'git:diff:stats',
  GIT_GENERATE_COMMIT_MSG: 'git:generate-commit-msg',
  GIT_GENERATE_BRANCH_NAME: 'git:generate-branch-name',
  GIT_CODE_REVIEW_START: 'git:code-review:start',
  GIT_CODE_REVIEW_STOP: 'git:code-review:stop',
  GIT_CODE_REVIEW_DATA: 'git:code-review:data',
  GIT_GH_STATUS: 'git:gh:status',
  GIT_PR_LIST: 'git:pr:list',
  GIT_PR_FETCH: 'git:pr:fetch',
  // Git Clone
  GIT_CLONE: 'git:clone',
  GIT_CLONE_PROGRESS: 'git:clone:progress',
  GIT_VALIDATE_URL: 'git:validate-url',
  // Git Blame
  GIT_BLAME: 'git:blame',
  // Git Revert & Reset
  GIT_REVERT: 'git:revert',
  GIT_RESET: 'git:reset',

  // Git Auto Fetch
  GIT_AUTO_FETCH_SET_ENABLED: 'git:autoFetch:setEnabled',
  GIT_AUTO_FETCH_COMPLETED: 'git:autoFetch:completed',

  // Git Submodule
  GIT_SUBMODULE_LIST: 'git:submodule:list',
  GIT_SUBMODULE_INIT: 'git:submodule:init',
  GIT_SUBMODULE_UPDATE: 'git:submodule:update',
  GIT_SUBMODULE_SYNC: 'git:submodule:sync',
  GIT_SUBMODULE_FETCH: 'git:submodule:fetch',
  GIT_SUBMODULE_PULL: 'git:submodule:pull',
  GIT_SUBMODULE_PUSH: 'git:submodule:push',
  GIT_SUBMODULE_COMMIT: 'git:submodule:commit',
  GIT_SUBMODULE_STAGE: 'git:submodule:stage',
  GIT_SUBMODULE_UNSTAGE: 'git:submodule:unstage',
  GIT_SUBMODULE_DISCARD: 'git:submodule:discard',
  GIT_SUBMODULE_CHANGES: 'git:submodule:changes',
  GIT_SUBMODULE_FILE_DIFF: 'git:submodule:file-diff',
  GIT_SUBMODULE_BRANCHES: 'git:submodule:branches',
  GIT_SUBMODULE_CHECKOUT: 'git:submodule:checkout',

  // Worktree
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_ADD: 'worktree:add',
  WORKTREE_REMOVE: 'worktree:remove',
  WORKTREE_ACTIVATE: 'worktree:activate',
  WORKTREE_MERGE: 'worktree:merge',
  WORKTREE_MERGE_STATE: 'worktree:merge:state',
  WORKTREE_MERGE_CONFLICTS: 'worktree:merge:conflicts',
  WORKTREE_MERGE_CONFLICT_CONTENT: 'worktree:merge:conflictContent',
  WORKTREE_MERGE_RESOLVE: 'worktree:merge:resolve',
  WORKTREE_MERGE_ABORT: 'worktree:merge:abort',
  WORKTREE_MERGE_CONTINUE: 'worktree:merge:continue',

  // Temporary Workspace
  TEMP_WORKSPACE_CREATE: 'temp:workspace:create',
  TEMP_WORKSPACE_REMOVE: 'temp:workspace:remove',
  TEMP_WORKSPACE_CHECK_PATH: 'temp:workspace:checkPath',

  // Folder
  FOLDER_CHECK_TYPE: 'folder:checkType',

  // Files
  FILE_READ: 'file:read',
  // D4: raw bytes for ONE user-picked attachment (path -> bytes). Distinct
  // from FILE_READ, which decodes text and returns '' for binary content.
  FILE_READ_ATTACHMENT: 'file:readAttachment',
  FILE_WRITE: 'file:write',
  FILE_SAVE_TO_TEMP: 'file:save-to-temp',
  FILE_CREATE: 'file:create',
  FILE_CREATE_DIR: 'file:createDir',
  FILE_RENAME: 'file:rename',
  FILE_MOVE: 'file:move',
  FILE_COPY: 'file:copy',
  FILE_BATCH_MOVE: 'file:batchMove',
  FILE_BATCH_COPY: 'file:batchCopy',
  FILE_CHECK_CONFLICTS: 'file:checkConflicts',
  FILE_DELETE: 'file:delete',
  FILE_LIST: 'file:list',
  FILE_EXISTS: 'file:exists',
  FILE_REVEAL_IN_FILE_MANAGER: 'file:revealInFileManager',
  FILE_WATCH_START: 'file:watch:start',
  FILE_WATCH_STOP: 'file:watch:stop',
  FILE_CHANGE: 'file:change',

  // Terminal
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_GET_ACTIVITY: 'terminal:getActivity',

  // Session
  SESSION_CREATE: 'session:create',
  SESSION_ATTACH: 'session:attach',
  SESSION_DETACH: 'session:detach',
  SESSION_KILL: 'session:kill',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_GET_ACTIVITY: 'session:getActivity',
  SESSION_DATA: 'session:data',
  SESSION_EXIT: 'session:exit',
  SESSION_STATE: 'session:state',

  // Pi embedded TUI
  PI_TUI_OPEN: 'piTui:open',
  PI_TUI_WRITE: 'piTui:write',
  PI_TUI_RESIZE: 'piTui:resize',
  PI_TUI_SUSPEND: 'piTui:suspend',
  PI_TUI_DISPOSE: 'piTui:dispose',
  PI_TUI_STATUS: 'piTui:status',
  PI_TUI_DATA: 'piTui:data',
  PI_TUI_EXIT: 'piTui:exit',
  PI_TUI_STATE: 'piTui:state',

  // App
  APP_GET_PATH: 'app:getPath',
  APP_TAKE_PENDING_OPEN_PATH: 'app:takePendingOpenPath',
  APP_UPDATE_AVAILABLE: 'app:updateAvailable',
  APP_CLOSE_REQUEST: 'app:closeRequest',
  APP_CLOSE_CONFIRM: 'app:closeConfirm',
  APP_CLOSE_RESPONSE: 'app:closeResponse',
  APP_CLOSE_SAVE_REQUEST: 'app:closeSaveRequest',
  APP_CLOSE_SAVE_RESPONSE: 'app:closeSaveResponse',
  APP_OPEN_PATH: 'app:openPath',
  APP_SET_LANGUAGE: 'app:setLanguage',
  APP_SET_PROXY: 'app:setProxy',
  APP_TEST_PROXY: 'app:testProxy',
  APP_QUIT: 'app:quit',

  // Window Controls (for frameless window)
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximizedChanged',
  WINDOW_OPEN_DEVTOOLS: 'window:openDevTools',
  WINDOW_DEVTOOLS_STATE_CHANGED: 'window:devtools:stateChanged',
  WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE: 'window:setTrafficLightsVisible',
  WINDOW_IS_FULLSCREEN: 'window:isFullScreen',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullScreenChanged',
  WINDOW_GET_REPOSITORY_RUNTIME_CONTEXT: 'window:getRepositoryRuntimeContext',
  // Dialog
  DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  // D4: multi-select sibling of DIALOG_OPEN_FILE. Returns string[] ([] on
  // cancel) and issues the one-shot read allowlist for the picked paths.
  DIALOG_OPEN_FILES: 'dialog:openFiles',

  // Remote connections
  REMOTE_PROFILE_LIST: 'remote:profile:list',
  REMOTE_PROFILE_SAVE: 'remote:profile:save',
  REMOTE_PROFILE_DELETE: 'remote:profile:delete',
  REMOTE_TEST_CONNECTION: 'remote:testConnection',
  REMOTE_CONNECT: 'remote:connect',
  REMOTE_DISCONNECT: 'remote:disconnect',
  REMOTE_GET_STATUS: 'remote:getStatus',
  SESSION_STORAGE_GET: 'sessionStorage:get',
  SESSION_STORAGE_SYNC_LOCAL_STORAGE: 'sessionStorage:syncLocalStorage',
  SESSION_STORAGE_IMPORT_LOCAL_STORAGE: 'sessionStorage:importLocalStorage',
  SESSION_STORAGE_IS_LEGACY_LOCAL_STORAGE_MIGRATED: 'sessionStorage:isLegacyLocalStorageMigrated',
  REMOTE_DIRECTORY_LIST: 'remote:directory:list',
  REMOTE_RUNTIME_STATUS: 'remote:helper:status',
  REMOTE_RUNTIME_INSTALL: 'remote:helper:install',
  REMOTE_RUNTIME_UPDATE: 'remote:helper:update',
  REMOTE_RUNTIME_DELETE: 'remote:helper:delete',
  REMOTE_BROWSE_ROOTS: 'remote:browseRoots',
  REMOTE_AUTH_PROMPT: 'remote:auth:prompt',
  REMOTE_AUTH_RESPONSE: 'remote:auth:response',
  REMOTE_STATUS_CHANGED: 'remote:statusChanged',

  // Context Menu
  CONTEXT_MENU_SHOW: 'contextMenu:show',

  // App Detector
  APP_DETECT: 'app:detect',
  APP_OPEN_WITH: 'app:openWith',
  APP_GET_ICON: 'app:getIcon',
  APP_RECENT_PROJECTS: 'app:recentProjects',

  // Git Validate Local Path
  GIT_VALIDATE_LOCAL_PATH: 'git:validate-local-path',

  // Tmux
  TMUX_CHECK: 'tmux:check',
  TMUX_KILL_SESSION: 'tmux:killSession',

  // CLI Installer
  CLI_INSTALL_STATUS: 'cli:install:status',
  CLI_INSTALL: 'cli:install',
  CLI_UNINSTALL: 'cli:uninstall',

  // Shell Detector
  SHELL_DETECT: 'shell:detect',
  SHELL_RESOLVE_FOR_COMMAND: 'shell:resolveForCommand',

  // Settings
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',

  // Phase 5 — managed Pi model metadata sync (keys never cross this IPC).
  PI_MODELS_GET_STATUS: 'piModels:getStatus',
  PI_MODELS_SYNC: 'piModels:sync',
  PI_MODELS_OPEN_ADMIN: 'piModels:openAdmin',

  // T08-c — the pi permission policy: read every scope, write the one we own.
  PI_PERMISSIONS_GET: 'piPermissions:get',
  PI_PERMISSIONS_UPDATE: 'piPermissions:update',
  PI_PERMISSIONS_RESET: 'piPermissions:reset',
  PI_PERMISSIONS_REVEAL: 'piPermissions:reveal',

  // Notification
  NOTIFICATION_SHOW: 'notification:show',
  NOTIFICATION_CLICK: 'notification:click',

  // Updater
  UPDATER_CHECK: 'updater:check',
  UPDATER_QUIT_AND_INSTALL: 'updater:quitAndInstall',
  UPDATER_STATUS: 'updater:status',
  UPDATER_SET_AUTO_UPDATE_ENABLED: 'updater:setAutoUpdateEnabled',
  UPDATER_DOWNLOAD_UPDATE: 'updater:downloadUpdate',

  // Read-only legacy conversation import
  LEGACY_IMPORT_LIST_PROJECTS: 'legacy-import:listProjects',
  LEGACY_IMPORT_LIST_SESSIONS: 'legacy-import:listSessions',
  LEGACY_IMPORT_BATCH: 'legacy-import:batch',

  // Pi worker runtime availability gate.
  PI_RUNTIME_CHECK: 'pi:runtime:check',

  // Auth (D47 S5) — login-state gate. `getGateSnapshot` is the single-call
  // `{managed, state, skipAuthGate}` atomic read `resolveGateDecision`
  // consumes; `stateChanged` is the value-changed-only push.
  AUTH_GET_GATE_SNAPSHOT: 'auth:getGateSnapshot',
  AUTH_ENTER_APP: 'auth:enterApp',
  AUTH_STATE_CHANGED: 'auth:stateChanged',
  // Dev-only (D47 S5 §5 GUI point-check ⑧) — registered ONLY when
  // `!app.isPackaged`; forces `vault.markInvalidated` so the failed-login
  // path can be exercised without a real key rejection.
  AUTH_DEV_MARK_INVALIDATED: 'auth:devMarkInvalidated',

  // Search
  SEARCH_FILES: 'search:files',
  SEARCH_CONTENT: 'search:content',

  // Usage
  USAGE_GET_STATS: 'usage:getStats',

  // Onboarding
  ONBOARDING_CHECK: 'onboarding:check',
  ONBOARDING_SEND_CODE: 'onboarding:sendCode',
  ONBOARDING_VERIFY_AND_REGISTER: 'onboarding:verifyAndRegister',
  ONBOARDING_CHECK_PREREQUISITES: 'onboarding:checkPrerequisites',
  ONBOARDING_INSTALL_GIT: 'onboarding:installGit',
  ONBOARDING_LOGOUT: 'onboarding:logout',

  // OpenChamber Chat / Agent Host Runtime
  CHAT_ENSURE_HOST: 'chat:ensureHost',
  CHAT_GET_HOST_STATUS: 'chat:getHostStatus',
  CHAT_CREATE_SESSION: 'chat:createSession',
  /**
   * Index-only session registration (R5 D2): records the session in
   * `session-index.json` WITHOUT starting the Agent Host or creating a
   * runtime session. Lets a freshly created "New" chat be renamed/archived
   * before its first message ever reaches the Host.
   */
  CHAT_REGISTER_SESSION: 'chat:registerSession',
  /**
   * U05-a — allocate (or return) the isolated working directory of a session
   * the user never bound to a project folder. Idempotent per session; Main
   * owns the base path, so the renderer can never nominate one.
   */
  CHAT_ENSURE_SCRATCH_WORKSPACE: 'chat:ensureScratchWorkspace',
  CHAT_RESUME_SESSION: 'chat:resumeSession',
  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  CHAT_CLOSE_SESSION: 'chat:closeSession',
  /**
   * T11 — answer one portable `extensionUi.request`. The addressee is a bridge
   * runtime plus dialog id, not a session or legacy permission dialect.
   */
  CHAT_RESPOND_EXTENSION_UI: 'chat:respondExtensionUi',
  /** U12 — set the session-level permission tier on the running Worker. */
  CHAT_SET_PERMISSION_TIER: 'chat:setPermissionTier',
  CHAT_LIST_SESSIONS: 'chat:listSessions',
  CHAT_RENAME_SESSION: 'chat:renameSession',
  CHAT_ARCHIVE_SESSION: 'chat:archiveSession',
  CHAT_LOAD_HISTORY_PAGE: 'chat:loadHistoryPage',
  CHAT_GET_SESSION_TREE: 'chat:getSessionTree',
  CHAT_REWIND_SESSION: 'chat:rewindSession',
  CHAT_FORK_SESSION: 'chat:forkSession',
  /** Pi-only model catalog; no provider credential or base URL crosses IPC. */
  CHAT_LIST_PI_MODELS: 'chat:listPiModels',
  /** Main → Renderer: Agent Host RuntimeEvent push */
  CHAT_RUNTIME_EVENT: 'chat:runtimeEvent',

  // Logging
  LOG_UPDATE_CONFIG: 'log:update-config',
  LOG_OPEN_FOLDER: 'log:open-folder',
  LOG_GET_PATH: 'log:get-path',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

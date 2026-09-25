/**
 * Why the renderer is being asked to confirm.
 *
 * `close-window` (T065) is the case the app used to call `quit-app` too: with a
 * second window open, closing one of them asked 「确定要退出应用吗？」 about an
 * app that was not going anywhere. `window-all-closed` quits, so the two really
 * are different outcomes, and the dialog now says which one it is.
 */
export type AppCloseRequestReason = 'quit-app' | 'close-window' | 'replace-window';

export interface AppCloseRequestPayload {
  requestId: string;
  reason: AppCloseRequestReason;
}

export const IPC_CHANNELS = {
  // Git
  GIT_STATUS: 'git:status',
  GIT_COMMIT: 'git:commit',
  GIT_FETCH: 'git:fetch',
  GIT_BRANCH_LIST: 'git:branch:list',
  GIT_BRANCH_CREATE: 'git:branch:create',
  GIT_BRANCH_CHECKOUT: 'git:branch:checkout',
  GIT_LOG: 'git:log',
  GIT_HEAD_SIGNATURE: 'git:head-signature',
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
  // T5: hand ONE previewable file (image / PDF) to the OS default viewer, for
  // the preview's "Open with system viewer" fallback. Existing regular files
  // with a preview extension only — never a directory or an executable.
  FILE_OPEN_WITH_SYSTEM_VIEWER: 'file:openWithSystemViewer',
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
  /** TUI-1: can the bundled pi CLI open this chat's session file at all? */
  PI_TUI_SESSION_SUPPORT: 'piTui:sessionSupport',
  PI_TUI_DATA: 'piTui:data',
  PI_TUI_EXIT: 'piTui:exit',
  PI_TUI_STATE: 'piTui:state',
  /** Main indexed the chats `/new` created in a terminal; re-read the list. */
  PI_TUI_SESSIONS_INDEXED: 'piTui:sessionsIndexed',

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

  // H/17 — AI services the user added themselves. Keys never cross this IPC:
  // reads answer with `hasApiKey`, and an edit that omits the key keeps it.
  USER_PROVIDERS_GET: 'userProviders:get',
  USER_PROVIDERS_UPSERT: 'userProviders:upsert',
  USER_PROVIDERS_REMOVE: 'userProviders:remove',
  USER_PROVIDERS_SET_ENABLED: 'userProviders:setEnabled',
  USER_PROVIDERS_FETCH_MODELS: 'userProviders:fetchModels',

  // R04 — Pi skills and prompt-template installation locations.
  PI_RESOURCES_GET_SETTINGS: 'piResources:getSettings',
  PI_RESOURCES_UPDATE_SETTINGS: 'piResources:updateSettings',
  PI_RESOURCES_OPEN_PROMPTS: 'piResources:openPromptTemplates',
  PI_RESOURCES_OPEN_SKILLS: 'piResources:openSkills',

  // P5-2-5 — managing the native subagent definitions.
  PI_SUBAGENTS_LIST: 'piSubagents:list',
  PI_SUBAGENTS_SAVE: 'piSubagents:save',
  PI_SUBAGENTS_DELETE: 'piSubagents:delete',
  PI_SUBAGENTS_SET_ENABLED: 'piSubagents:setEnabled',
  PI_SUBAGENTS_CLEAR_STALE: 'piSubagents:clearStale',
  PI_SUBAGENTS_REVEAL: 'piSubagents:reveal',
  /** subagent-data-01 — preview and import legacy `<agentDir>/agents` documents. */
  PI_SUBAGENTS_IMPORT_PREVIEW: 'piSubagents:importPreview',
  PI_SUBAGENTS_IMPORT_APPLY: 'piSubagents:importApply',

  // H/19 U2 — copying `~/.pi/agent` into this app's own agent directory.
  AGENT_MIGRATION_INSPECT: 'agentMigration:inspect',
  AGENT_MIGRATION_APPLY: 'agentMigration:apply',

  // H/19 U4 — user-installed pi extensions, run through pi's own package manager.
  PI_PLUGINS_LIST: 'piPlugins:list',
  PI_PLUGINS_INSTALL: 'piPlugins:install',
  PI_PLUGINS_REMOVE: 'piPlugins:remove',
  PI_PLUGINS_SET_ENABLED: 'piPlugins:setEnabled',

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
  UPDATER_GET_STATUS: 'updater:getStatus',
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
  // The inverse of `enterApp`: drop this run's entry and stop running on the
  // user's own credentials, so the gate routes back to the sign-in screen.
  AUTH_REQUEST_SIGN_IN: 'auth:requestSignIn',
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

  // F09 announcements. `refresh` asks the service; `get` answers from what is
  // already on disk without a network call, so a renderer that mounts before
  // the first fetch lands still has something to show.
  ANNOUNCEMENTS_GET: 'announcements:get',
  ANNOUNCEMENTS_REFRESH: 'announcements:refresh',
  ANNOUNCEMENTS_MARK_READ: 'announcements:markRead',

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
  /**
   * Re-read a session's Pi JSONL after the embedded TUI wrote to it, and
   * replace the timeline with what is on disk. Distinct from resume: resume
   * short-circuits when the worker is already live, which is exactly the case
   * here.
   */
  CHAT_RELOAD_SESSION: 'chat:reloadSession',
  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  /**
   * Ask the agent loop to stop after its current turn and deliver a queued
   * message next. Ctrl+Enter in the composer.
   */
  CHAT_INTERJECT: 'chat:interject',
  CHAT_CLOSE_SESSION: 'chat:closeSession',
  /**
   * Answer one `permission.requested`. Addressed by session plus the
   * `permissionId` the timeline block and the pending queue already carry.
   */
  CHAT_RESPOND_PERMISSION: 'chat:respondPermission',
  /**
   * F5 — answer one `question.requested`. A second addressee next to the one
   * above: the `ask` tool's own question, keyed by the `questionId` the card
   * and the timeline block carry. The name existed once for the legacy
   * `canUseTool` path and was removed when that path went; it is back for a
   * different contract, which `chatPiWorkerRouting.test.ts` pins.
   */
  CHAT_RESPOND_QUESTION: 'chat:respondQuestion',
  /** U12 — set the session-level permission tier on the running Worker. */
  CHAT_SET_PERMISSION_TIER: 'chat:setPermissionTier',
  CHAT_SET_PERMISSIONS: 'chat:setPermissions',
  /**
   * T026 — what one session's own runtime brought up: MCP servers and their
   * connection state, skill and prompt-template counts, sub-agent definitions.
   *
   * Replaced `chat:listSessionExtensions`, which answered with the pi extension
   * list — a field with no producer since P6-5, so the sidebar reported "0
   * plugins" for every session (cutover-03).
   *
   * A pull rather than an event: the inventory is fixed for the life of a
   * bootstrap, so pushing it would add traffic to every session start for a
   * panel that is usually closed. `null` back means nobody has reported —
   * no live worker, or a build that reports no inventory — which is a different
   * answer from an inventory whose members are empty.
   */
  CHAT_LIST_SESSION_CAPABILITIES: 'chat:listSessionCapabilities',
  CHAT_LIST_SESSIONS: 'chat:listSessions',
  CHAT_RENAME_SESSION: 'chat:renameSession',
  CHAT_ARCHIVE_SESSION: 'chat:archiveSession',
  CHAT_LOAD_HISTORY_PAGE: 'chat:loadHistoryPage',
  /**
   * T102 (decision 030) — one page of a session's transcript, read straight
   * off its JSONL by Main, with no worker involved.
   *
   * The sibling of `chat:loadHistoryPage`, not a replacement: that one asks a
   * live worker, whose in-memory branch is the authority while it exists. This
   * one is for the case that had no answer before — a session nobody is
   * running, which used to have to be resumed (a worker slot, possibly a
   * `worker_capacity_reached` refusal) just to be looked at. It refuses with
   * `worker_active` when the session does have a worker, so the caller can use
   * the other channel.
   *
   * Publishes its page as a `session.history` runtime event, exactly like the
   * worker path, and deliberately publishes NOTHING else: a preview must not
   * emit `session.resumed`, which is what binds a session to a host.
   */
  CHAT_READ_SESSION_PAGE: 'chat:readSessionPage',
  CHAT_GET_SESSION_TREE: 'chat:getSessionTree',
  /** R02-b — slash commands for the composer's completion menu. */
  CHAT_GET_SLASH_COMMANDS: 'chat:getSlashCommands',
  /** R02-c — manual context compaction. */
  CHAT_COMPACT_SESSION: 'chat:compactSession',
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

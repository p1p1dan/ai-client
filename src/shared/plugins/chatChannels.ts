/**
 * How chat calls are classed, for the session-control check (plugin-system
 * README §4) and for what plugins may call (§3).
 *
 * Channel names are the IPC ones (`IPC_CHANNELS.CHAT_*`), spelled out so the
 * plugin SDK can list them without importing the renderer's IPC table.
 */

/**
 * Calls that change a conversation. Only the session's controller may make
 * them; anyone else gets `session_controlled_elsewhere`. Stop is not here on
 * purpose: either side may stop a turn.
 */
export const CONTROLLED_CHAT_CHANNELS: ReadonlySet<string> = new Set([
  'chat:send',
  'chat:retryLastTurn',
  'chat:interject',
  'chat:withdrawInterjection',
  'chat:respondPermission',
  'chat:respondQuestion',
  'chat:setPermissions',
  'chat:setPermissionTier',
  'chat:compactSession',
  'chat:cancelCompact',
  'chat:runSessionCommand',
  'chat:rewindSession',
  'chat:killSessionJob',
  'chat:interruptSubagent',
  'chat:backgroundTool',
]);

/** Reads a plugin with `chat.read` may make. */
export const PLUGIN_CHAT_READ_CHANNELS: ReadonlySet<string> = new Set([
  'chat:getHostStatus',
  'chat:listSessions',
  'chat:listSessionCapabilities',
  'chat:getSlashCommands',
  'chat:getSessionPanels',
  'chat:readSessionPage',
  'chat:loadHistoryPage',
  'chat:resumeSession',
  'chat:peekHistory',
]);

/** Changes a plugin with `chat.control` may make (the controlled ones still need control). */
export const PLUGIN_CHAT_CONTROL_CHANNELS: ReadonlySet<string> = new Set([
  'chat:createSession',
  'chat:registerSession',
  'chat:ensureScratchWorkspace',
  'chat:renameSession',
  'chat:archiveSession',
  'chat:stop',
  'chat:send',
  'chat:retryLastTurn',
  'chat:interject',
  'chat:withdrawInterjection',
  'chat:respondPermission',
  'chat:respondQuestion',
  'chat:setPermissions',
  'chat:setPermissionTier',
  'chat:compactSession',
  'chat:cancelCompact',
  'chat:runSessionCommand',
]);

/** Code a refused controlled call is rejected with. */
export const SESSION_CONTROLLED_ELSEWHERE = 'session_controlled_elsewhere';

/**
 * Chat search: read one session's searchable messages, whichever engine it
 * runs on. The engine is the row's, as `chat:readSessionPage` decides it
 * (`src/main/ipc/chat.ts`): a `pi` row is a legacy pi file, a `dsh` row whose
 * identity is a `.ccsdk.json` stub is an Agent SDK chat, any other `dsh` row
 * is a DSH chat.
 *
 * Every dependency that touches a host or the disk is injected, so the
 * readers run under plain Node in tests.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_SDK_STUB_SUFFIX } from '@shared/claudeSdkEngine';
import { HISTORY_PAGE_MAX_LIMIT } from '@shared/dshHistory/page';
import { DSH_AGENT, PI_AGENT, resolveAgentWireName } from '@shared/types/agentWire';
import type { SessionHistoryPage } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { claudeTranscriptMessages } from './claudeTranscript';
import { type IndexedMessage, indexableHistory } from './extract';

export type ChatSearchEngine = 'dsh' | 'claude-sdk' | 'legacy-pi';

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface SessionReaderDeps {
  /** `dshHostSupervisor.readPage`. */
  readDshPage(request: {
    stubFile: string;
    logicalSessionId: string;
    offset: number;
    limit: number;
  }): Promise<SessionHistoryPage>;
  /** `readSessionReplayPage` (`SessionReplayReader.ts`). */
  readLegacyPage(request: {
    sessionFile: string;
    offset: number;
    limit: number;
    workspacePath?: string;
  }): Promise<SessionHistoryPage>;
  /** `readFileTsdSafeBounded`: the encrypted target cannot read a Node-written file directly. */
  readFile(file: string): Promise<Buffer>;
  /** `<appStateRoot>/claude`, the SDK host's config dir. */
  claudeConfigDir: string;
}

export function engineOf(row: SessionIndexEntry): ChatSearchEngine | null {
  const agent = resolveAgentWireName(row.agent);
  if (!row.runtimeIdentity) return null;
  if (agent === PI_AGENT) return 'legacy-pi';
  if (agent !== DSH_AGENT) return null;
  return row.runtimeIdentity.endsWith(CLAUDE_SDK_STUB_SUFFIX) ? 'claude-sdk' : 'dsh';
}

/** Upper bound on pages per session (500 messages each). */
const MAX_PAGES = 40;

/** Every page, newest first as the readers count them, joined back in timeline order. */
async function readAllPages(
  read: (request: PageRequest) => Promise<SessionHistoryPage>
): Promise<SessionHistoryPage['messages']> {
  const pages: SessionHistoryPage['messages'][] = [];
  let offset = 0;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const page = await read({ offset, limit: HISTORY_PAGE_MAX_LIMIT });
    pages.unshift(page.messages);
    offset += page.messages.length;
    if (!page.hasMore || page.messages.length === 0) break;
  }
  return pages.flat();
}

/** The CLI's own project-dir name for `cwd` (Claude Code's `sanitizePath`, short paths). */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The transcript of `ccSessionId`: the copy under the chat's own cwd when
 * there is one, else the newest copy anywhere under `projects/` (a chat that
 * entered a worktree writes under that worktree's directory).
 */
export async function findClaudeTranscript(
  configDir: string,
  ccSessionId: string,
  cwd: string | undefined
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(ccSessionId)) return null;
  const root = path.join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  const own = cwd ? projectDirName(cwd) : undefined;
  let best: { file: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    const file = path.join(root, dir, `${ccSessionId}.jsonl`);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size === 0) continue;
    if (dir === own) return file;
    if (!best || info.mtimeMs > best.mtimeMs) best = { file, mtimeMs: info.mtimeMs };
  }
  return best?.file ?? null;
}

async function readClaudeSession(
  row: SessionIndexEntry & { runtimeIdentity: string },
  deps: SessionReaderDeps
): Promise<IndexedMessage[]> {
  const stub = JSON.parse((await deps.readFile(row.runtimeIdentity)).toString('utf8')) as {
    ccSessionId?: unknown;
    cwd?: unknown;
    started?: unknown;
  };
  if (typeof stub.ccSessionId !== 'string') {
    throw new Error(`malformed Claude SDK session stub: ${row.runtimeIdentity}`);
  }
  // Nothing sent yet: the CLI has written no transcript.
  if (stub.started !== true) return [];
  const cwd = typeof stub.cwd === 'string' ? stub.cwd : row.workspacePath;
  const file = await findClaudeTranscript(deps.claudeConfigDir, stub.ccSessionId, cwd);
  if (!file) return [];
  return claudeTranscriptMessages((await deps.readFile(file)).toString('utf8'));
}

/** One session's searchable messages, in timeline order. Throws when the session cannot be read. */
export async function readSessionMessages(
  row: SessionIndexEntry,
  deps: SessionReaderDeps
): Promise<IndexedMessage[]> {
  const engine = engineOf(row);
  if (!engine || !row.runtimeIdentity) return [];
  const identity = row.runtimeIdentity;
  switch (engine) {
    case 'claude-sdk':
      return readClaudeSession({ ...row, runtimeIdentity: identity }, deps);
    case 'dsh':
      return indexableHistory(
        await readAllPages((page) =>
          deps.readDshPage({ stubFile: identity, logicalSessionId: row.sessionId, ...page })
        )
      );
    case 'legacy-pi':
      return indexableHistory(
        await readAllPages((page) =>
          deps.readLegacyPage({
            sessionFile: identity,
            ...page,
            ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
          })
        )
      );
  }
}

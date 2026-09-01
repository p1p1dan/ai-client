import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  isLegacyImportPathSegment,
  type LegacyImportProject,
  type LegacyImportSessionPreview,
} from '@shared/types';
import {
  isFileTsdEncrypted,
  readFileTsdSafeBounded,
  TsdFileTooLargeError,
} from '../../utils/tsdSafeRead';

type JsonlContentBlock = { type?: string; text?: string };
type JsonlMessage = { content?: JsonlContentBlock[] | string };

type JsonlEntry = {
  type?: string;
  subtype?: string;
  cwd?: string;
  model?: string;
  timestamp?: number | string;
  created_at?: number | string;
  message?: JsonlMessage;
};

export type ClaudeSessionRootKind = 'managed' | 'legacy';

/** A `~/.claude`-shaped config dir (contains `projects/`) to scan. */
export interface ClaudeSessionRoot {
  dir: string;
  kind: ClaudeSessionRootKind;
}

export interface ClaudeSessionScannerOptions {
  /**
   * Lazy provider — invoked once per public method call, never cached at
   * construction time. This mirrors the pre-refactor behavior (no
   * constructor at all; `getClaudeProjectsDir()` re-read `CLAUDE_CONFIG_DIR`
   * on every call) so the module-level import service keeps
   * following env/flag changes made after import (D47 S2 §0.1 — "没有构造
   * 函数...今天能跟随重定向正因无构造期捕获").
   */
  resolveRoots: () => ClaudeSessionRoot[];
}

/**
 * Pre-refactor single-root resolution (`CLAUDE_CONFIG_DIR ?? ~/.claude`),
 * exported so both the flag-off production wiring and tests can share the
 * exact same "legacy" root computation instead of re-deriving it.
 */
export function resolveLegacyClaudeSessionRoot(
  env: NodeJS.ProcessEnv = process.env
): ClaudeSessionRoot {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return { dir, kind: 'legacy' };
}

function getProjectsDir(root: ClaudeSessionRoot): string {
  return path.join(root.dir, 'projects');
}

function safeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function assertSafeSegment(value: string, label: string): void {
  if (!isLegacyImportPathSegment(value)) throw new Error(`Invalid Claude ${label}`);
}

async function listRootProjectIds(root: ClaudeSessionRoot): Promise<string[]> {
  const projectsDir = getProjectsDir(root);
  try {
    const dirents = await fs.readdir(projectsDir, { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') return [];
    console.error(
      `[ClaudeSessionScanner] Failed to read ${root.kind} projects directory (${safeErrorCode(error)})`
    );
    return [];
  }
}

async function listRootSessionFiles(root: ClaudeSessionRoot, projectId: string): Promise<string[]> {
  const projectDir = path.join(getProjectsDir(root), projectId);
  try {
    return await listSessionFiles(projectDir);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') return [];
    console.error(
      `[ClaudeSessionScanner] Failed to list ${root.kind} project ${projectId} sessions (${safeErrorCode(error)})`
    );
    return [];
  }
}

export interface ClaudeSessionSource {
  projectId: string;
  sessionId: string;
  workspacePath: string;
  configDir: string;
  filePath: string;
  rootKind: ClaudeSessionRootKind;
}

interface SessionFileCandidate {
  root: ClaudeSessionRoot;
  fileName: string;
  fullPath: string;
  sessionId: string;
  mtimeMs: number;
}

/**
 * Gathers every session file across all roots for one project, degrading
 * per-root/per-file on stat failure instead of aborting the whole scan
 * (D47 S2b §1 Scanner: "单根 stat 失败降级为另一根继续 + 诊断").
 */
async function collectSessionFileCandidates(
  roots: ClaudeSessionRoot[],
  projectId: string
): Promise<SessionFileCandidate[]> {
  assertSafeSegment(projectId, 'project id');
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      const fileNames = await listRootSessionFiles(root, projectId);
      const projectDir = path.join(getProjectsDir(root), projectId);
      const stats = await Promise.all(
        fileNames.map(async (fileName) => {
          const fullPath = path.join(projectDir, fileName);
          try {
            const stat = await fs.stat(fullPath);
            const candidate: SessionFileCandidate = {
              root,
              fileName,
              fullPath,
              sessionId: path.basename(fileName, '.jsonl'),
              mtimeMs: stat.mtimeMs,
            };
            return candidate;
          } catch (error) {
            console.warn(
              `[ClaudeSessionScanner] Failed to inspect ${root.kind} session ${path.basename(fileName, '.jsonl')} (${safeErrorCode(error)})`
            );
            return null;
          }
        })
      );
      return stats.filter((s): s is SessionFileCandidate => !!s);
    })
  );
  return perRoot.flat();
}

/** Deterministic tie-break (D47 S2b §1 Scanner): higher mtimeMs wins; equal mtime → managed wins. */
function pickWinningCandidate(candidates: SessionFileCandidate[]): SessionFileCandidate {
  return candidates.reduce((winner, candidate) => {
    if (candidate.mtimeMs > winner.mtimeMs) return candidate;
    if (candidate.mtimeMs < winner.mtimeMs) return winner;
    if (candidate.root.kind === 'managed' && winner.root.kind !== 'managed') return candidate;
    return winner;
  });
}

/** Session key = (projectId, sessionId) — this dedupes only within one projectId's candidates. */
function dedupeSessionCandidates(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
  const bySessionId = new Map<string, SessionFileCandidate[]>();
  for (const candidate of candidates) {
    const list = bySessionId.get(candidate.sessionId) ?? [];
    list.push(candidate);
    bySessionId.set(candidate.sessionId, list);
  }
  return [...bySessionId.values()].map((list) => pickWinningCandidate(list));
}

function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function parseTimestampSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values larger than ~2001-09-09 in ms are likely millisecond timestamps.
    if (value > 1_000_000_000_000) return toUnixSeconds(value);
    if (value > 0) return Math.floor(value);
    return null;
  }

  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return toUnixSeconds(t);
  }

  return null;
}

function extractTimestampSeconds(entry: JsonlEntry): number | null {
  return (
    parseTimestampSeconds(entry.timestamp) ??
    parseTimestampSeconds(entry.created_at) ??
    parseTimestampSeconds((entry as { createdAt?: unknown }).createdAt)
  );
}

function extractText(message: JsonlMessage | undefined): string | null {
  const content = message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text || null;
  }

  if (!Array.isArray(content)) return null;

  const text = content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();

  return text || null;
}

function truncatePreview(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}…`;
}

/** Strip known Claude Code system/command wrapper tags, returning only user-authored text. */
function stripSystemTags(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

/** Extract slash-command name from system tags as a display fallback. */
function extractCommandLabel(text: string): string | null {
  const match = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  return match ? `/${match[1].trim()}` : null;
}

function decodeProjectDirNameFallback(dirName: string): string {
  const raw = dirName.startsWith('-') ? dirName.slice(1) : dirName;
  const parts = raw.split('-').filter(Boolean);
  if (parts.length === 0) return dirName;

  // Windows-like: "-d-Projects-app" -> "D:\Projects\app"
  if (parts[0].length === 1 && /^[a-zA-Z]$/.test(parts[0])) {
    const drive = parts[0].toUpperCase();
    const rest = parts.slice(1);
    return `${drive}:\\${rest.join('\\')}`;
  }

  // POSIX-like: "-home-user-project" -> "/home/user/project"
  return `/${parts.join('/')}`;
}

function isSessionJsonlFile(fileName: string): boolean {
  if (!fileName.endsWith('.jsonl')) return false;
  return !fileName.startsWith('agent-');
}

async function listSessionFiles(projectDir: string): Promise<string[]> {
  const dirents = await fs.readdir(projectDir, { withFileTypes: true });
  return dirents.filter((d) => d.isFile() && isSessionJsonlFile(d.name)).map((d) => d.name);
}

interface JsonlReader {
  lines: AsyncIterable<string>;
  close: () => void;
}

async function openJsonlReader(filePath: string): Promise<JsonlReader> {
  // On Windows machines running TEC OCular Agent, JSONL files written by Node
  // (e.g. claude CLI) are TSD-encrypted on disk. The packaged Electron binary
  // is not whitelisted, so streaming reads return raw encrypted bytes and JSON
  // parsing fails. Detect the TSD header and fall back to a buffered read via
  // system node.exe, which IS whitelisted and yields decrypted bytes.
  if (await isFileTsdEncrypted(filePath)) {
    let splitLines: string[] = [];
    try {
      const decrypted = await readFileTsdSafeBounded(filePath);
      splitLines = decrypted.toString('utf-8').split('\n');
    } catch (error) {
      // Only swallow the size guard — that is an intentional degradation for
      // pathological session logs. Anything else (spawn failure, decrypt
      // error, fs read fault) is a real problem that should surface to the
      // caller so it can mark the session as failed instead of silently
      // returning "no content".
      if (!(error instanceof TsdFileTooLargeError)) {
        throw error;
      }
      console.warn(
        `[ClaudeSessionScanner] Skipping oversized encrypted session (${error.size} bytes > ${error.limit} bytes)`
      );
    }
    return {
      lines: (async function* () {
        for (const line of splitLines) yield line;
      })(),
      close: () => {
        // No file handle to release for the buffered/decrypted path.
      },
    };
  }

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  // Both rl and the underlying stream must be torn down on early-exit (e.g.
  // `for await` only consumes the first 300 lines). Releasing only the
  // readline interface leaves the file descriptor open — visible as file
  // locks on Windows.
  let closed = false;
  return {
    lines: rl,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
      try {
        stream.destroy();
      } catch {
        // ignore
      }
    },
  };
}

async function readTailLines(filePath: string, lineCount: number): Promise<string[]> {
  // TSD-encrypted files cannot be read via positional reads, so route through
  // the buffered TSD-safe path; otherwise stick with the chunked reader.
  if (await isFileTsdEncrypted(filePath)) {
    try {
      const decrypted = await readFileTsdSafeBounded(filePath);
      const lines = decrypted
        .toString('utf-8')
        .split('\n')
        .filter((l) => l.trim());
      return lines.slice(-lineCount);
    } catch (error) {
      // Only swallow the size guard. Other errors (spawn / decrypt / fs)
      // propagate so the caller can decide how to surface them rather than
      // silently treating the session as having no content.
      if (!(error instanceof TsdFileTooLargeError)) {
        throw error;
      }
      console.warn(
        `[ClaudeSessionScanner] Skipping tail of oversized encrypted session (${error.size} bytes > ${error.limit} bytes)`
      );
      return [];
    }
  }

  const CHUNK_SIZE = 8 * 1024;
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    let collected = '';
    let position = fileSize;

    while (position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      collected = buffer.toString('utf-8') + collected;

      const lines = collected.split('\n').filter((l) => l.trim());
      if (lines.length >= lineCount) {
        return lines.slice(-lineCount);
      }
    }

    return collected.split('\n').filter((l) => l.trim());
  } finally {
    await handle.close();
  }
}

async function readInitCwdFromJsonl(filePath: string): Promise<string | null> {
  let reader: JsonlReader;
  try {
    reader = await openJsonlReader(filePath);
  } catch (error) {
    console.error(
      `[ClaudeSessionScanner] Failed to open session ${path.basename(filePath, '.jsonl')} (${safeErrorCode(error)})`
    );
    return null;
  }

  let lineIndex = 0;
  let fallbackCwd: string | null = null;
  let result: string | null = null;
  try {
    for await (const line of reader.lines) {
      lineIndex += 1;
      if (lineIndex > 300) break;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: JsonlEntry | null = null;
      try {
        entry = JSON.parse(trimmed) as JsonlEntry;
      } catch {
        continue;
      }

      if (entry.type === 'system' && entry.subtype === 'init' && typeof entry.cwd === 'string') {
        const cwd = entry.cwd.trim();
        if (cwd) {
          result = cwd;
          break;
        }
      }

      if (fallbackCwd === null && typeof entry.cwd === 'string') {
        const cwd = entry.cwd.trim();
        if (cwd) fallbackCwd = cwd;
      }
    }
  } catch (error) {
    console.error(
      `[ClaudeSessionScanner] Failed while reading session ${path.basename(filePath, '.jsonl')} (${safeErrorCode(error)})`
    );
    return null;
  } finally {
    reader.close();
  }

  return result ?? fallbackCwd;
}

export class ClaudeSessionScanner {
  private readonly resolveRoots: () => ClaudeSessionRoot[];

  constructor(options: ClaudeSessionScannerOptions) {
    this.resolveRoots = options.resolveRoots;
  }

  async decodeProjectPath(projectId: string): Promise<string> {
    const roots = this.resolveRoots();
    const candidates = await collectSessionFileCandidates(roots, projectId);
    if (candidates.length === 0) {
      return decodeProjectDirNameFallback(projectId);
    }
    return this.decodeProjectPathFromCandidates(projectId, candidates);
  }

  async scanProjects(): Promise<LegacyImportProject[]> {
    const roots = this.resolveRoots();

    const projectIdSets = await Promise.all(roots.map((root) => listRootProjectIds(root)));
    const projectIds = [...new Set(projectIdSets.flat())];

    const projects = await Promise.all(
      projectIds.map(async (projectId): Promise<LegacyImportProject | null> => {
        const candidates = await collectSessionFileCandidates(roots, projectId);
        if (candidates.length === 0) return null;

        // Project aggregation across roots (D47 S2b §1 Scanner): same slug
        // merges — sessionCount is deduped by session key, lastActivityAt
        // takes the max across every candidate (dedup doesn't change the max).
        const winners = dedupeSessionCandidates(candidates);
        const lastActivityMs = candidates.reduce((max, c) => Math.max(max, c.mtimeMs), 0);
        const initCwd = await this.decodeProjectPathFromCandidates(projectId, winners);

        return {
          id: projectId,
          path: initCwd,
          sessionCount: winners.length,
          lastActivityAt: lastActivityMs ? toUnixSeconds(lastActivityMs) : 0,
        };
      })
    );

    return projects
      .filter((p): p is LegacyImportProject => !!p)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async getSessionsForProject(projectId: string): Promise<LegacyImportSessionPreview[]> {
    const roots = this.resolveRoots();
    const candidates = await collectSessionFileCandidates(roots, projectId);
    const winners = dedupeSessionCandidates(candidates);

    const sessions = await Promise.all(
      winners.map(async (candidate) => {
        try {
          return await this.extractSessionMeta(projectId, candidate);
        } catch (error) {
          // Per-session failures (e.g. TSD spawn/decrypt error) must not abort
          // the whole project scan. Drop this session and move on.
          console.error(
            `[ClaudeSessionScanner] Failed to inspect session ${candidate.sessionId} (${safeErrorCode(error)})`
          );
          return null;
        }
      })
    );

    return sessions
      .filter((s): s is LegacyImportSessionPreview => !!s)
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
  }

  async resolveSessionSource(
    projectId: string,
    sessionId: string
  ): Promise<ClaudeSessionSource | null> {
    assertSafeSegment(projectId, 'project id');
    assertSafeSegment(sessionId, 'session id');
    const candidates = await collectSessionFileCandidates(this.resolveRoots(), projectId);
    const winner = dedupeSessionCandidates(candidates).find(
      (candidate) => candidate.sessionId === sessionId
    );
    if (!winner) return null;
    return {
      projectId,
      sessionId,
      workspacePath: await this.decodeProjectPathFromCandidates(projectId, [winner]),
      configDir: winner.root.dir,
      filePath: winner.fullPath,
      rootKind: winner.root.kind,
    };
  }

  private async extractSessionMeta(
    projectId: string,
    candidate: SessionFileCandidate
  ): Promise<LegacyImportSessionPreview | null> {
    const { fullPath: filePath, sessionId } = candidate;

    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return null;
    }

    const createdAtFallback = toUnixSeconds(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs);
    const lastAtFallback = toUnixSeconds(stat.mtimeMs);

    let firstMessage: string | null = null;
    let commandFallback: string | null = null;
    let model: string | null = null;
    let createdAt: number | null = null;

    const reader = await openJsonlReader(filePath);

    let lineIndex = 0;
    try {
      for await (const line of reader.lines) {
        lineIndex += 1;
        if (lineIndex > 300) break;
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: JsonlEntry | null = null;
        try {
          entry = JSON.parse(trimmed) as JsonlEntry;
        } catch {
          continue;
        }

        if (createdAt === null) {
          const ts = extractTimestampSeconds(entry);
          if (ts !== null) createdAt = ts;
        }

        if (model === null && entry.type === 'system' && entry.subtype === 'init') {
          if (typeof entry.model === 'string' && entry.model.trim()) {
            model = entry.model.trim();
          }
        }

        if (firstMessage === null && entry.type === 'user') {
          const text = extractText(entry.message);
          if (text) {
            const cleaned = stripSystemTags(text);
            if (cleaned) {
              firstMessage = truncatePreview(cleaned, 80);
            } else if (commandFallback === null) {
              commandFallback = extractCommandLabel(text);
            }
          }
        }

        if (createdAt !== null && model !== null && firstMessage !== null) {
          break;
        }
      }
    } finally {
      reader.close();
    }

    const tailLines = await readTailLines(filePath, 50);
    let lastMessageAt: number | null = null;
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const trimmed = tailLines[i].trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as JsonlEntry;
        const ts = extractTimestampSeconds(entry);
        if (ts !== null) {
          lastMessageAt = ts;
          break;
        }
      } catch {
        // skip malformed tail line
      }
    }

    return {
      id: sessionId,
      projectId,
      firstMessage: firstMessage ?? commandFallback,
      createdAt: createdAt ?? createdAtFallback,
      lastMessageAt: lastMessageAt ?? lastAtFallback,
      model,
      importedSnapshots: 0,
    };
  }

  private async decodeProjectPathFromCandidates(
    projectId: string,
    candidates: SessionFileCandidate[]
  ): Promise<string> {
    for (const candidate of candidates) {
      const initCwd = await readInitCwdFromJsonl(candidate.fullPath);
      if (initCwd) return initCwd;
    }

    return decodeProjectDirNameFallback(projectId);
  }
}

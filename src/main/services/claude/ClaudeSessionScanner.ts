import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ClaudeProject, ClaudeSessionMeta } from '@shared/types';
import { isFileTsdEncrypted, readFileTsdSafe } from '../../utils/tsdSafeRead';

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

function getClaudeProjectsDir(): string {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'projects');
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
    const decrypted = await readFileTsdSafe(filePath);
    const text = decrypted.toString('utf-8');
    const splitLines = text.split('\n');
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
    const decrypted = await readFileTsdSafe(filePath);
    const lines = decrypted.toString('utf-8').split('\n').filter((l) => l.trim());
    return lines.slice(-lineCount);
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
  const reader = await openJsonlReader(filePath);

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
  } finally {
    reader.close();
  }

  return result ?? fallbackCwd;
}

export class ClaudeSessionScanner {
  async decodeProjectPath(projectId: string): Promise<string> {
    const projectsDir = getClaudeProjectsDir();
    const projectDir = path.join(projectsDir, projectId);

    let sessionFiles: string[] = [];
    try {
      sessionFiles = await listSessionFiles(projectDir);
    } catch {
      return decodeProjectDirNameFallback(projectId);
    }

    return this.decodeProjectPathFromFiles(projectId, projectDir, sessionFiles);
  }

  async scanProjects(): Promise<ClaudeProject[]> {
    const projectsDir = getClaudeProjectsDir();

    let dirents: Array<import('node:fs').Dirent> = [];
    try {
      dirents = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') return [];
      console.error('[ClaudeSessionScanner] Failed to read projects dir:', error);
      return [];
    }

    const projectIds = dirents.filter((d) => d.isDirectory()).map((d) => d.name);

    const projects = await Promise.all(
      projectIds.map(async (projectId): Promise<ClaudeProject | null> => {
        const projectDir = path.join(projectsDir, projectId);

        let sessionFiles: string[] = [];
        try {
          sessionFiles = await listSessionFiles(projectDir);
        } catch {
          return null;
        }
        if (sessionFiles.length === 0) return null;

        const sessionStats = await Promise.all(
          sessionFiles.map(async (fileName) => {
            const fullPath = path.join(projectDir, fileName);
            try {
              const stat = await fs.stat(fullPath);
              return { fileName, mtimeMs: stat.mtimeMs };
            } catch {
              return null;
            }
          })
        );

        const lastActivityMs = sessionStats
          .filter((s): s is { fileName: string; mtimeMs: number } => !!s)
          .reduce((max, s) => Math.max(max, s.mtimeMs), 0);

        const initCwd = await this.decodeProjectPathFromFiles(projectId, projectDir, sessionFiles);

        return {
          id: projectId,
          path: initCwd,
          sessionCount: sessionFiles.length,
          lastActivityAt: lastActivityMs ? toUnixSeconds(lastActivityMs) : 0,
        };
      })
    );

    return projects
      .filter((p): p is ClaudeProject => !!p)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async getSessionsForProject(projectId: string): Promise<ClaudeSessionMeta[]> {
    const projectsDir = getClaudeProjectsDir();
    const projectDir = path.join(projectsDir, projectId);

    let sessionFiles: string[] = [];
    try {
      sessionFiles = await listSessionFiles(projectDir);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') return [];
      console.error('[ClaudeSessionScanner] Failed to list project sessions:', error);
      return [];
    }

    const sessions = await Promise.all(
      sessionFiles.map(async (fileName) => this.extractSessionMeta(projectId, projectDir, fileName))
    );

    return sessions
      .filter((s): s is ClaudeSessionMeta => !!s)
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
  }

  private async extractSessionMeta(
    projectId: string,
    projectDir: string,
    fileName: string
  ): Promise<ClaudeSessionMeta | null> {
    const filePath = path.join(projectDir, fileName);
    const sessionId = path.basename(fileName, '.jsonl');

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
    };
  }

  private async decodeProjectPathFromFiles(
    projectId: string,
    projectDir: string,
    sessionFiles: string[]
  ): Promise<string> {
    for (const fileName of sessionFiles) {
      const fullPath = path.join(projectDir, fileName);
      const initCwd = await readInitCwdFromJsonl(fullPath);
      if (initCwd) return initCwd;
    }

    return decodeProjectDirNameFallback(projectId);
  }
}

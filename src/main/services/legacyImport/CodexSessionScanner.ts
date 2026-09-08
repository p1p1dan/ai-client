import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LEGACY_IMPORT_MAX_SOURCE_BYTES, type LegacyImportSourceFingerprint } from '@shared/types';
import { type CodexRollout, parseCodexRollout } from './CodexRollout';

export interface CodexSessionSource {
  projectId: string;
  sessionId: string;
  filePath: string;
  rollout: CodexRollout;
  fingerprint: LegacyImportSourceFingerprint;
}

export interface CodexSessionSummary {
  projectId: string;
  sessionId: string;
  filePath: string;
  workspacePath: string;
  firstMessage: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
}

export function codexProjectId(workspacePath: string): string {
  return `codex-${createHash('sha256').update(workspacePath).digest('hex')}`;
}

export async function readCodexSessionSource(filePath: string): Promise<CodexSessionSource> {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > LEGACY_IMPORT_MAX_SOURCE_BYTES) {
      throw new Error('Codex source is not a supported regular file');
    }
    // Read at most the observed size plus one byte: a concurrently growing file
    // must not turn a bounded import into an unbounded readFile allocation.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode
    ) {
      throw new Error('Codex source changed while reading; retry the import step');
    }
    const content = bytes.subarray(0, length);
    const rollout = parseCodexRollout(content.toString('utf8'));
    return {
      projectId: codexProjectId(rollout.workspacePath),
      sessionId: rollout.sessionId,
      filePath,
      rollout,
      fingerprint: {
        stableSourceIdentity: createHash('sha256')
          .update(`codex:${resolve(filePath)}`)
          .digest('hex'),
        contentHash: createHash('sha256').update(content).digest('hex'),
        size: before.size,
        mode: before.mode,
        mtimeMs: before.mtimeMs,
      },
    };
  } finally {
    await handle.close();
  }
}

export class CodexSessionScanner {
  constructor(
    private readonly resolveRoot: () => string = () =>
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  ) {}

  async scan(): Promise<CodexSessionSummary[]> {
    const result: CodexSessionSummary[] = [];
    let inspectedFiles = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (++inspectedFiles > 10_000) throw new Error('Codex scan exceeds session limit');
        try {
          const source = await readCodexSessionSource(path);
          const user = source.rollout.entries.find((item) => item.kind === 'user');
          if (
            user?.kind === 'user' &&
            source.rollout.entries.some((item) => item.kind === 'assistant')
          ) {
            result.push({
              projectId: source.projectId,
              sessionId: source.sessionId,
              filePath: source.filePath,
              workspacePath: source.rollout.workspacePath,
              firstMessage: user.text.slice(0, 256),
              model: source.rollout.model,
              startedAt: source.rollout.startedAt,
              endedAt: source.rollout.endedAt,
            });
          }
        } catch (error) {
          // A corrupt session does not hide valid siblings. Root/directory
          // failures propagate to the per-source scan isolation boundary.
          console.warn(
            '[CodexSessionScanner] Skipped unreadable session',
            error instanceof Error ? error.name : 'unknown'
          );
        }
      }
    };
    try {
      await walk(this.resolveRoot(), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return result;
  }

  async resolveSessionSource(projectId: string, sessionId: string): Promise<CodexSessionSource> {
    const matches = (await this.scan()).filter(
      (item) => item.projectId === projectId && item.sessionId === sessionId
    );
    if (matches.length !== 1) throw new Error('Codex session is missing or ambiguous');
    const source = await readCodexSessionSource(matches[0].filePath);
    if (source.projectId !== projectId || source.sessionId !== sessionId)
      throw new Error('Codex session identity changed during selection');
    return source;
  }
}

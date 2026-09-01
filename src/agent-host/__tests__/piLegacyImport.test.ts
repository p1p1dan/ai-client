import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportedConversation } from '../../shared/types/legacyImport.ts';
import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../../shared/types/legacyImport.ts';
import type { PiSdkModule } from '../piAgentSessionBootstrap.ts';
import { PiLegacyImportWriter } from '../piLegacyImport.ts';

let root: string;
let cwd: string;
let targetDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pi-legacy-import-'));
  cwd = path.join(root, 'workspace');
  targetDir = path.join(root, 'sessions');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function conversation(): ImportedConversation {
  return {
    schemaVersion: 1,
    importerVersion: 'test-v1',
    sourceKind: 'claude-code',
    stableSourceIdentity: 'stable-source',
    sourceSessionId: 'claude-session',
    workspacePath: cwd,
    title: 'Imported test',
    sourceFingerprint: {
      stableSourceIdentity: 'stable-source',
      contentHash: 'abc123',
      size: 42,
      mode: 0o100644,
      mtimeMs: 1,
    },
    entries: [
      { kind: 'user', sourceEntryId: 'u1', timestamp: 1, text: 'hello' },
      {
        kind: 'assistant',
        sourceEntryId: 'a1',
        timestamp: 2,
        blocks: [
          { type: 'thinking', text: 'thought' },
          { type: 'text', text: 'answer' },
          { type: 'tool_call', toolCallId: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
        ],
      },
      {
        kind: 'tool_result',
        sourceEntryId: 'r1',
        timestamp: 3,
        toolCallId: 'tool-1',
        toolName: 'Read',
        output: 'contents',
        isError: false,
      },
      {
        kind: 'display',
        sourceEntryId: 'd1',
        timestamp: 4,
        displayKind: 'custom',
        title: 'Unsupported legacy block',
        body: 'display only',
      },
    ],
    diagnostics: [],
  };
}

async function sdk(): Promise<PiSdkModule> {
  const real = await import('@earendil-works/pi-coding-agent');
  return {
    SessionManager: {
      create: (
        requestedCwd: string,
        sessionDir?: string,
        options?: { id?: string; parentSession?: string }
      ) => {
        if (!sessionDir) {
          return {
            getSessionDir: () => targetDir,
            getCwd: () => requestedCwd,
          };
        }
        return real.SessionManager.create(requestedCwd, sessionDir, options);
      },
      open: (sessionFile: string) => real.SessionManager.open(sessionFile),
      continueRecent: (requestedCwd: string, sessionDir?: string) =>
        real.SessionManager.continueRecent(requestedCwd, sessionDir),
      inMemory: (requestedCwd?: string) => real.SessionManager.inMemory(requestedCwd),
    },
  } as unknown as PiSdkModule;
}

describe('PiLegacyImportWriter', () => {
  it('publishes a native Pi v3 file, validates history, and keeps custom display out of context', async () => {
    const writer = new PiLegacyImportWriter(sdk);
    const result = await writer.create({
      logicalSessionId: 'logical-import',
      targetPiSessionId: 'import-test-1',
      conversation: conversation(),
    });

    expect(result.finalSessionFile).toContain(targetDir);
    expect(result.history.page.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'system' }),
      ])
    );
    const content = await readFile(result.finalSessionFile, 'utf8');
    expect(content).toContain(`"customType":"${LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE}"`);
    expect(content).toContain(`"customType":"${LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY}"`);

    const real = await import('@earendil-works/pi-coding-agent');
    const opened = real.SessionManager.open(result.finalSessionFile);
    const context = opened.buildSessionContext();
    expect(JSON.stringify(context.messages)).not.toContain('display only');
    expect(JSON.stringify(context.messages)).toContain('hello');
    expect(JSON.stringify(context.messages)).toContain('answer');

    expect(await writer.inspectInterrupted(cwd, 'import-test-1')).toEqual({
      sessionFiles: [result.finalSessionFile],
    });
    expect(await writer.reconcileInterrupted(cwd, 'import-test-1')).toEqual({
      removedFiles: 1,
      remainingFiles: 0,
    });
    await expect(stat(result.finalSessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);
});

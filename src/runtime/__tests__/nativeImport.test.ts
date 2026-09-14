/**
 * P5-4 — conversation import on the native backend.
 *
 * The cases worth pinning are the ones where a wrong importer produces a file
 * that LOOKS imported: an id nobody can find it by, a transcript that reads
 * fine but feeds the model rows that were never meant as context, or a staged
 * leftover that blocks every retry with "destination already exists".
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Context } from 'cordis';
import { describe, expect, it } from 'vitest';
import type { ImportedConversation } from '../../shared/types/legacyImport.ts';
import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../../shared/types/legacyImport.ts';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostIoService } from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import { JsonlSessionStore } from '../plugins/session/store.ts';
import { NativeLegacyImportWriter } from '../worker/nativeImport.ts';

function conversation(
  workspacePath: string,
  overrides: Partial<ImportedConversation> = {}
): ImportedConversation {
  return {
    schemaVersion: 1,
    importerVersion: 'b4-legacy-v2',
    sourceKind: 'claude-code',
    stableSourceIdentity: 'claude:/home/me/proj:abc',
    sourceSessionId: 'abc',
    workspacePath,
    title: '修一个登录缺陷',
    model: 'claude-sonnet-5',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    sourceFingerprint: {
      stableSourceIdentity: 'claude:/home/me/proj:abc',
      contentHash: 'deadbeef',
      size: 10,
      mode: 0o600,
      mtimeMs: 1,
    },
    entries: [
      { kind: 'user', text: '登录页点不动', timestamp: 1_700_000_000_000 },
      {
        kind: 'assistant',
        blocks: [
          { type: 'thinking', text: '先看事件绑定' },
          { type: 'text', text: '按钮的 onClick 被覆盖了' },
          { type: 'tool_call', toolCallId: 'call-1', name: 'read', input: { path: 'a.ts' } },
        ],
        model: 'claude-sonnet-5',
        timestamp: 1_700_000_050_000,
      },
      {
        kind: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: 'export const a = 1;',
        isError: false,
        timestamp: 1_700_000_060_000,
      },
      {
        kind: 'display',
        displayKind: 'attachment',
        title: '截图（未保留）',
        body: 'image/png',
        redacted: true,
        timestamp: 1_700_000_070_000,
      },
    ],
    diagnostics: ['1 个附件只保留了说明'],
    ...overrides,
  };
}

async function withWriter<T>(
  run: (input: {
    writer: NativeLegacyImportWriter;
    agentDir: string;
    workspace: string;
    /** A reader's own IO, so nothing here has to reach inside the writer. */
    io: RuntimeHostIoService;
  }) => Promise<T>
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), 'native-import-agent-'));
  const workspace = await mkdtemp(join(tmpdir(), 'native-import-ws-'));
  const writer = new NativeLegacyImportWriter(standaloneHost({}), agentDir);
  const ctx = new Context();
  await ctx.plugin(ExecPlugin, standaloneHost({}));
  const fiber = await ctx.plugin(HostIoPlugin, standaloneHost({}));
  await fiber.await();
  try {
    return await run({
      writer,
      agentDir,
      workspace,
      io: ctx.runtimeHostIo as RuntimeHostIoService,
    });
  } finally {
    await writer.dispose();
    await ctx.fiber.dispose();
    await rm(agentDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function entriesOf(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('NativeLegacyImportWriter', () => {
  it('publishes a v4 session under the id Main allocated', async () => {
    await withWriter(async ({ writer, agentDir, workspace }) => {
      const result = await writer.create({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-1234',
        conversation: conversation(workspace),
      });

      expect(result.finalSessionFile).toContain('import-claude-code-1234.jsonl');
      expect(result.piSessionId).toBe('import-claude-code-1234');
      const rows = await entriesOf(result.finalSessionFile);
      expect(rows[0]).toMatchObject({
        kind: 'header',
        version: 4,
        id: 'import-claude-code-1234',
      });
      // The staging directory is gone from the published path's point of view:
      // nothing is left under the id that a retry would trip over.
      expect(
        (await writer.inspectInterrupted(workspace, 'import-claude-code-1234')).sessionFiles
      ).toEqual([join(agentDir, 'sessions', 'import-claude-code-1234.jsonl')]);
    });
  });

  it('records both custom entry types, so the timeline renders what pi rendered', async () => {
    await withWriter(async ({ writer, workspace }) => {
      const result = await writer.create({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-1234',
        conversation: conversation(workspace),
      });
      // `kind` first: since H/20 the bookkeeping rows carry a v3 `custom` type
      // of their own so the CLI can chain through them.
      const customTypes = (await entriesOf(result.finalSessionFile))
        .filter((row) => row.kind === 'entry' && row.type === 'custom')
        .map((row) => row.customType);
      expect(customTypes).toEqual([
        LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
        LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
      ]);
    });
  });

  it('keeps display-only rows out of model context while showing them in history', async () => {
    await withWriter(async ({ writer, workspace, io }) => {
      const result = await writer.create({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-1234',
        conversation: conversation(workspace),
      });
      const store = await JsonlSessionStore.open(io, {
        file: result.finalSessionFile,
        cwd: workspace,
        mode: 'resume',
      });
      try {
        const snapshot = store.snapshot();
        expect(
          snapshot.messages.some(
            (message) =>
              (message as { customType?: unknown }).customType === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY
          )
        ).toBe(false);
        expect(snapshot.messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'toolResult',
        ]);
        expect(store.metadata().title).toBe('修一个登录缺陷');
      } finally {
        await store.close();
      }
      // The same rows the renderer will draw.
      expect(result.history.page.messages.length).toBeGreaterThan(0);
    });
  });

  it('refuses a conversion that kept no assistant reply, and leaves nothing behind', async () => {
    await withWriter(async ({ writer, agentDir, workspace }) => {
      await expect(
        writer.create({
          logicalSessionId: 'logical-1',
          targetPiSessionId: 'import-claude-code-empty',
          conversation: conversation(workspace, {
            entries: [{ kind: 'user', text: '只有我说话', timestamp: 1 }],
          }),
        })
      ).rejects.toThrow(/assistant response/);
      await expect(
        stat(join(agentDir, 'sessions', 'import-claude-code-empty.jsonl'))
      ).rejects.toThrow();
      expect(
        (await writer.inspectInterrupted(workspace, 'import-claude-code-empty')).sessionFiles
      ).toEqual([]);
    });
  });

  it('reconciles a leftover from an import that died mid-write', async () => {
    await withWriter(async ({ writer, agentDir, workspace, io }) => {
      // Exactly the state a killed writer leaves: a staged file, no published one.
      const staging = join(agentDir, 'sessions', '.aiclient-import-staging');
      const staged = await JsonlSessionStore.open(io, {
        file: join(staging, 'import-claude-code-9.jsonl'),
        cwd: workspace,
        mode: 'create',
        id: 'import-claude-code-9',
      });
      await staged.close();

      expect(
        (await writer.inspectInterrupted(workspace, 'import-claude-code-9')).sessionFiles
      ).toEqual([join(staging, 'import-claude-code-9.jsonl')]);
      expect(await writer.reconcileInterrupted(workspace, 'import-claude-code-9')).toEqual({
        removedFiles: 1,
        remainingFiles: 0,
      });
    });
  });

  it('discards only the file it published', async () => {
    await withWriter(async ({ writer, workspace }) => {
      const result = await writer.create({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-1234',
        conversation: conversation(workspace),
      });
      expect(await writer.discard('/somewhere/else.jsonl')).toEqual({ discarded: false });
      expect(await writer.discard(result.finalSessionFile)).toEqual({ discarded: true });
      await expect(stat(result.finalSessionFile)).rejects.toThrow();
      // A second discard is not an error, and does not claim a second deletion.
      expect(await writer.discard(result.finalSessionFile)).toEqual({ discarded: false });
    });
  });

  it('produces a session the ordinary resume path can reopen', async () => {
    await withWriter(async ({ writer, workspace, io }) => {
      const result = await writer.create({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-1234',
        conversation: conversation(workspace),
      });
      const reopened = await JsonlSessionStore.open(io, {
        file: result.finalSessionFile,
        cwd: workspace,
        mode: 'resume',
      });
      try {
        expect(reopened.snapshot().id).toBe('import-claude-code-1234');
        expect(reopened.snapshot().messages.at(0)).toMatchObject({ role: 'user' });
      } finally {
        await reopened.close();
      }
    });
  });
});

/**
 * IM04 — an imported conversation is not an archive, it is a session you can
 * carry on.
 *
 * H/21 made "可续聊" the hard acceptance for conversation import, and switching
 * backends must not quietly downgrade it. Run offline against pi-ai's faux
 * provider: what is being proved is that the imported turns become MODEL
 * CONTEXT, not that a gateway answers.
 */
describe('an imported session continues on the native runtime', () => {
  it('sends the imported turns to the model as context', async () => {
    await withWriter(async ({ writer, workspace }) => {
      const result = await writer.create({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-resume',
        conversation: conversation(workspace),
      });

      const seen: unknown[][] = [];
      const handle = fauxProvider({ provider: 'faux', models: [{ id: 'faux-resume' }] });
      handle.setResponses([
        (context) => {
          seen.push([...context.messages]);
          return fauxAssistantMessage('接着上次说');
        },
      ]);

      const runtime = await createRuntime({
        env: {},
        providers: [handle.provider],
        session: { file: result.finalSessionFile, cwd: workspace, mode: 'resume' },
      });
      try {
        await runtime.run({ prompt: '继续', systemPrompt: 'probe' });
      } finally {
        await runtime.dispose();
      }

      const sent = seen.at(0) as { role: string; content?: unknown }[];
      expect(sent.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'toolResult',
        'user',
      ]);
      expect(JSON.stringify(sent)).toContain('登录页点不动');
      // The display-only row is in the transcript and NOT in what was sent.
      expect(JSON.stringify(sent)).not.toContain('截图（未保留）');
    });
  });
});

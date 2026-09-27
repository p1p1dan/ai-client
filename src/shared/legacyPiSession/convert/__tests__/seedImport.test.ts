import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectDshHistory } from '../../../dshHistory/projection.ts';
import type {
  ImportedAssistantBlock,
  ImportedConversation,
  ImportedConversationEntry,
} from '../../../types/legacyImport.ts';
import type { HistoryMessage } from '../../../types/sessionHistory.ts';
import { branchEntries, decodeSession } from '../../codec.ts';
import {
  checkSeed,
  convertImportedConversation,
  convertPiSessionBytes,
  type DshSeedEvent,
  importIdPrefix,
  type SeedConversion,
} from '../index.ts';

/**
 * dsh-rebase P1-9b / decision 056 — a CC / Codex conversation straight to a
 * DSH seed.
 *
 * The two import files of the legacy corpus are what 1.0.x's native writer
 * made of a known `ImportedConversation`; reading that conversation back out
 * of them gives a real input, and importing it directly must show what
 * migrating the 1.0.x import shows.
 */

const CORPUS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../__tests__/fixtures/legacy-pi'
);

type Row = Record<string, unknown>;

/** The conversation `nativeImport.ts` wrote into `file`, read back. */
function conversationOf(file: string): ImportedConversation {
  const document = decodeSession(readFileSync(path.join(CORPUS, file), 'utf8'));
  const branch = branchEntries(document);
  const provenance = branch.find(
    (entry) => entry.type === 'custom' && entry.customType === 'aiclient.legacy-import.provenance'
  ) as { data: Row } | undefined;
  const meta = provenance?.data ?? {};
  const entries: ImportedConversationEntry[] = branch.flatMap(
    (entry): ImportedConversationEntry[] => {
      if (entry.type === 'custom' && entry.customType === 'aiclient.legacy-import.display') {
        const { version: _version, ...display } = entry.data as Row;
        return [{ kind: 'display', ...display } as ImportedConversationEntry];
      }
      if (entry.type !== 'message') return [];
      const message = entry.message;
      if (message.role === 'user')
        return [{ kind: 'user', text: String(message.content), timestamp: message.timestamp }];
      if (message.role === 'assistant')
        return [
          {
            kind: 'assistant',
            model: message.model,
            timestamp: message.timestamp,
            blocks: message.content.map(
              (block): ImportedAssistantBlock =>
                block.type === 'text'
                  ? { type: 'text', text: block.text }
                  : block.type === 'thinking'
                    ? { type: 'thinking', text: block.thinking }
                    : {
                        type: 'tool_call',
                        toolCallId: block.id,
                        name: block.name,
                        input: block.arguments,
                      }
            ),
          },
        ];
      if (message.role === 'toolResult')
        return [
          {
            kind: 'tool_result',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: message.content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join(''),
            isError: message.isError,
            timestamp: message.timestamp,
          },
        ];
      return [];
    }
  );
  return {
    schemaVersion: 1,
    importerVersion: String(meta.importerVersion),
    sourceKind: meta.sourceKind as ImportedConversation['sourceKind'],
    stableSourceIdentity: String(meta.stableSourceIdentity),
    sourceSessionId: String(meta.sourceSessionId),
    workspacePath: document.header.cwd,
    title: document.name ?? 'Imported',
    ...(typeof meta.startedAt === 'number' ? { startedAt: meta.startedAt } : {}),
    ...(typeof meta.endedAt === 'number' ? { endedAt: meta.endedAt } : {}),
    sourceFingerprint: {
      stableSourceIdentity: String(meta.stableSourceIdentity),
      contentHash: String(meta.contentHash),
      size: 0,
      mode: 0,
      mtimeMs: 0,
    },
    entries,
    diagnostics: (meta.diagnostics as string[]) ?? [],
  };
}

function imported(conversation: ImportedConversation): SeedConversion {
  const result = convertImportedConversation(conversation);
  if (!result.ok) throw new Error(`${result.failure.code}: ${result.message}`);
  return result;
}

/** What a row shows, without the ids and times the two paths legitimately differ in. */
function shown(rows: readonly HistoryMessage[]) {
  return rows.map((row) => ({
    role: row.role,
    ...(row.model ? { model: row.model } : {}),
    blocks: row.blocks.map((block) => {
      const { id: _id, ...rest } = block;
      if (rest.type === 'text' && rest.notice)
        return { ...rest, text: '', notice: { key: rest.notice.key } };
      return rest;
    }),
  }));
}

const messageId = (event: DshSeedEvent) => {
  const data = event.data as Row;
  return String(event.type === 'user/message' ? data.id : (data.message as Row | undefined)?.id);
};

describe.each([
  'v4-import-claude.jsonl',
  'v4-import-codex.jsonl',
])('importing %s directly', (file) => {
  const conversation = conversationOf(file);

  it('shows what migrating the 1.0.x import shows', () => {
    const direct = imported(conversation);
    const migrated = convertPiSessionBytes(readFileSync(path.join(CORPUS, file)), {
      sourceFile: `/corpus/${file}`,
      cwd: conversation.workspacePath,
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(shown(projectDshHistory(direct.seed))).toEqual(shown(projectDshHistory(migrated.seed)));
  });

  it('writes a valid seed with deterministic import ids, provenance first, no usage', () => {
    const direct = imported(conversation);
    expect(checkSeed(direct.seed)).toEqual([]);
    expect(imported(conversation)).toEqual(direct);
    const prefix = importIdPrefix(conversation);
    expect(prefix).toMatch(/^imp-[0-9a-f]{12}$/);
    expect(direct.seed[0]).toMatchObject({
      type: 'aiclient/legacy-provenance',
      seq: 0,
      ignorable: true,
      data: { version: 1, sourceKind: conversation.sourceKind, entryId: `${prefix}-provenance` },
    });
    const messages = direct.seed.filter((event) => /message|tool\/result/.test(event.type));
    for (const event of messages)
      expect(messageId(event)).toMatch(new RegExp(`^${prefix}-\\d+(:sys0)?$`));
    for (const event of direct.seed.filter((item) => item.type === 'assistant/message')) {
      const data = event.data as Row;
      expect(data.usage).toBeUndefined();
      expect(data.message).toMatchObject({ source: { kind: 'model', provider: 'legacy-import' } });
      expect((data.message as Row).source).not.toHaveProperty('replayState');
    }
    expect(direct.origin).toMatchObject({ kind: 'imported-conversation', idPrefix: prefix });
    expect(direct.report.source).toMatchObject({
      kind: 'imported-conversation',
      generation: conversation.sourceKind,
    });
  });

  it('keeps every display row an ignorable record, never model context', () => {
    const direct = imported(conversation);
    const displays = conversation.entries.filter((entry) => entry.kind === 'display').length;
    const records = direct.seed.filter((event) => event.type === 'aiclient/legacy-display');
    expect(records).toHaveLength(displays);
    expect(
      records.every((event) => event.ignorable === true && event.surfaceOp === undefined)
    ).toBe(true);
  });
});

describe('import edge cases', () => {
  const base = conversationOf('v4-import-codex.jsonl');

  it('refuses a conversation with no reply, as 1.0.x did', () => {
    const result = convertImportedConversation({
      ...base,
      entries: base.entries.filter((entry) => entry.kind !== 'assistant'),
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { stage: 'build', code: 'WORKER_IMPORT_VALIDATION_FAILED' },
    });
  });

  it('shows a result with no matching call as a display-only tool row', () => {
    const direct = imported({
      ...base,
      entries: [
        ...base.entries,
        {
          kind: 'tool_result',
          toolCallId: 'lost',
          toolName: 'shell',
          output: 'out',
          isError: false,
        },
      ],
    });
    const last = direct.seed.filter((event) => event.type === 'aiclient/legacy-display').at(-1);
    expect(last?.data).toMatchObject({ displayKind: 'tool', toolCallId: 'lost', output: 'out' });
    expect(direct.report.lossy?.orphanResults).toBe(1);
  });

  it('closes an imported call that has no result, and still ends the turn completed', () => {
    const direct = imported({
      ...base,
      entries: [
        { kind: 'user', text: 'run it' },
        {
          kind: 'assistant',
          blocks: [
            { type: 'tool_call', toolCallId: 'c1', name: 'shell', input: { command: ['ls'] } },
          ],
        },
      ],
    });
    expect(direct.seed.filter((event) => event.type === 'tool/result')).toHaveLength(1);
    expect(direct.seed.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } });
  });
});

// New in dsh-rebase P1-9b

/**
 * A Claude Code / Codex conversation, as seed items (decision 056; plan P1-9
 * shard 02 §3). Main's scanners and `ImportedConversation` stay as they are;
 * this replaces the 1.0.x native writer (`runtime/worker/nativeImport.ts`),
 * keeping what that writer kept:
 *
 * - the provenance record first and every display row as its own record,
 *   now ignorable events, so they are shown as in 1.0.x and can never reach
 *   the model (which the caller still asserts, as 1.0.x did);
 * - replies attributed to the `legacy-import` provider, now with no usage at
 *   all instead of zeros, so the session total stays what this app spent.
 *
 * Ids are `imp-<first 12 hex of sha256(dedupe key)>-<entry index>`: stable
 * for one source snapshot, distinct across sources.
 */

import { createHash } from 'node:crypto';
import {
  type ImportedConversation,
  type ImportedConversationEntry,
  legacyImportDedupeKey,
} from '../../types/legacyImport.ts';
import { LEGACY_IMPORT_PROVIDER, toolArguments } from './assistant.ts';
import { plainJson } from './fromPi.ts';
import {
  type IrBlock,
  type IrItem,
  SEED_EVENT_TYPE,
  SEED_SOURCE_KIND,
  type SeedJson,
} from './types.ts';

export interface ImportIr {
  items: IrItem[];
  idPrefix: string;
  /** Ids of the display records, which must never become model-visible. */
  displayIds: string[];
  replies: number;
  entries: Record<string, number>;
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** `nativeImport.ts` `displayData`: the v1 record the projections read. */
function displayData(entry: Extract<ImportedConversationEntry, { kind: 'display' }>): {
  [key: string]: SeedJson;
} {
  return {
    version: 1,
    displayKind: entry.displayKind,
    title: entry.title,
    ...(entry.body !== undefined ? { body: entry.body } : {}),
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    ...(entry.input !== undefined ? { input: plainJson(entry.input) } : {}),
    ...(entry.output !== undefined ? { output: entry.output } : {}),
    ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
    ...(entry.redacted !== undefined ? { redacted: entry.redacted } : {}),
    ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
    ...(finiteTime(entry.timestamp) !== undefined ? { timestamp: entry.timestamp as number } : {}),
  };
}

export function importIdPrefix(conversation: ImportedConversation): string {
  const digest = createHash('sha256').update(legacyImportDedupeKey(conversation)).digest('hex');
  return `imp-${digest.slice(0, 12)}`;
}

export function importedConversationIr(conversation: ImportedConversation): ImportIr {
  const idPrefix = importIdPrefix(conversation);
  const model = (entryModel: string | undefined) =>
    entryModel || conversation.model || conversation.sourceKind;
  const entries: Record<string, number> = {};
  const displayIds: string[] = [];
  let replies = 0;
  let time =
    finiteTime(conversation.startedAt) ?? finiteTime(conversation.sourceFingerprint?.mtimeMs) ?? 0;
  const items: IrItem[] = [
    {
      kind: 'ignorable',
      time,
      type: SEED_EVENT_TYPE.legacyProvenance,
      data: plainJson({
        version: 1,
        sourceKind: conversation.sourceKind,
        stableSourceIdentity: conversation.stableSourceIdentity,
        sourceSessionId: conversation.sourceSessionId,
        contentHash: conversation.sourceFingerprint.contentHash,
        schemaVersion: conversation.schemaVersion,
        importerVersion: conversation.importerVersion,
        startedAt: conversation.startedAt,
        endedAt: conversation.endedAt,
        diagnostics: conversation.diagnostics,
        entryId: `${idPrefix}-provenance`,
      }),
    },
  ];
  conversation.entries.forEach((entry, index) => {
    const id = `${idPrefix}-${index}`;
    time = finiteTime(entry.timestamp) ?? time;
    entries[`import:${entry.kind}`] = (entries[`import:${entry.kind}`] ?? 0) + 1;
    switch (entry.kind) {
      case 'user':
        // Attachment diagnostics arrive as display rows of their own.
        items.push({
          kind: 'input',
          id,
          time,
          opensTurn: true,
          source: { kind: SEED_SOURCE_KIND.user },
          content: [{ type: 'text', text: entry.text }],
        });
        return;
      case 'assistant': {
        replies += 1;
        const content: IrBlock[] = entry.blocks.map((block): IrBlock => {
          if (block.type === 'text') return { type: 'text', text: block.text };
          if (block.type === 'thinking') return { type: 'reasoning', text: block.text };
          return {
            type: 'tool-call',
            id: block.toolCallId,
            name: block.name,
            arguments: toolArguments(block.input ?? {}),
          };
        });
        items.push({
          kind: 'assistant',
          id,
          time,
          outcome: 'message',
          ends: 'stop',
          content,
          provider: LEGACY_IMPORT_PROVIDER,
          model: model(entry.model),
          calls: content.flatMap((block) =>
            block.type === 'tool-call'
              ? [{ id: block.id, name: block.name, arguments: block.arguments }]
              : []
          ),
        });
        return;
      }
      case 'tool_result':
        items.push({
          kind: 'result',
          id,
          time,
          callId: entry.toolCallId,
          content: [{ type: 'text', text: entry.output }],
          isError: entry.isError,
          // A result with no open call is still shown, as a display-only row.
          orphan: {
            kind: 'ignorable',
            time,
            type: SEED_EVENT_TYPE.legacyDisplay,
            data: {
              version: 1,
              displayKind: 'tool',
              title: entry.toolName,
              toolCallId: entry.toolCallId,
              toolName: entry.toolName,
              output: entry.output,
              isError: entry.isError,
              ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
              entryId: id,
            },
          },
        });
        return;
      case 'display':
        displayIds.push(id);
        items.push({
          kind: 'ignorable',
          time,
          type: SEED_EVENT_TYPE.legacyDisplay,
          data: { ...displayData(entry), entryId: id },
        });
        return;
    }
  });
  return { items, idPrefix, displayIds, replies, entries };
}

// New in dsh-rebase P1-9b

/**
 * A decoded pi session's active branch, as the flat item stream the seed
 * builder turns into DSH turns and steps (plan P1-9 shard 02 §1).
 *
 * Only the active branch is read (decision 052). Items keep the branch's
 * order; ids are entry ids (decision 054) and times are entry times, so the
 * result depends on nothing but the document.
 */

import { attachmentNameOf } from '../../attachmentRider.ts';
import { internalMessageOrigin } from '../../internalMessage.ts';
import {
  encodeGrants,
  PERMISSION_GRANTS_ENTRY,
  type PersistedGrants,
  restoredGrants,
} from '../../permissions/grants.ts';
import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../../types/legacyImport.ts';
import type { RuntimePermissionSettings } from '../../types/runtimePermission.ts';
import { RUN_STOP_CUSTOM_TYPE } from '../../types/sessionHistory.ts';
import { branchEntries, CLI_BOOKKEEPING_TYPE, type SessionDocument } from '../codec.ts';
import { PERMISSIONS_ENTRY, sessionPermissions } from '../legacy.ts';
import type { AgentMessage, CompactionEntry, CustomEntry, Entry } from '../types.ts';
import { type AssistantCounts, piAssistant } from './assistant.ts';
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from './llmText.ts';
import {
  type IrBlock,
  type IrCheckpoint,
  type IrIgnorable,
  type IrInput,
  type IrItem,
  SEED_EVENT_TYPE,
  SEED_SOURCE_KIND,
  type SeedJson,
} from './types.ts';

/**
 * The fixed text 1.0.x's crash recovery gave a call whose result was lost
 * (`runtime/plugins/session/recovery.ts`). Copied, not imported: the runtime
 * is deleted in P1-12 and this library may not load it.
 */
export const LEGACY_RECOVERED_RESULT_TEXT =
  'The previous run ended before this tool result was recorded. Its effects are unknown; inspect the environment before deciding whether to repeat it.';

/** Custom entries that carry permission state: read into `legacyPermissions` / the sidecar, never events. */
const PERMISSION_RECORDS: ReadonlySet<string> = new Set([
  PERMISSIONS_ENTRY,
  PERMISSION_GRANTS_ENTRY,
  'aiclient-session-tier',
  'permission-tier',
]);
const SUBAGENT_RECORD = 'aiclient.subagent';

export interface PiIrCounts extends AssistantCounts {
  bookkeeping: number;
  labels: number;
  offBranchLabels: number;
  excludedFromContext: number;
  emptySummaries: number;
}

export interface PiIr {
  items: IrItem[];
  counts: PiIrCounts;
  branch: Entry[];
  grants: PersistedGrants | null;
  legacyPermissions: RuntimePermissionSettings | null;
}

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

/** Data as a DSH log stores it: undefined keys gone, `-0` normalized. */
export function plainJson(value: unknown): SeedJson {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as SeedJson);
}

/** User-role content (a prompt, a tool result, an extension message) as seed blocks. */
export function userBlocks(content: unknown): IrBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): IrBlock[] => {
    const block = recordOf(part);
    if (block?.type === 'text' && typeof block.text === 'string')
      return [{ type: 'text', text: block.text }];
    if (block?.type === 'image') {
      const mediaType =
        typeof block.mimeType === 'string'
          ? block.mimeType
          : typeof block.mediaType === 'string'
            ? block.mediaType
            : 'image/*';
      const name = attachmentNameOf(block);
      return [
        {
          type: 'image',
          mediaType,
          ...(typeof block.data === 'string' && block.data ? { data: block.data } : {}),
          ...(name ? { name } : {}),
        },
      ];
    }
    return [];
  });
}

function input(
  id: string,
  time: number,
  opensTurn: boolean,
  source: IrInput['source'],
  content: IrBlock[]
): IrItem {
  return { kind: 'input', id, time, opensTurn, source, content };
}

function textInput(id: string, time: number, kind: string, text: string): IrItem {
  return input(id, time, false, { kind }, [{ type: 'text', text }]);
}

function messageItems(
  id: string,
  time: number,
  message: AgentMessage,
  counts: PiIrCounts
): IrItem[] {
  switch (message.role) {
    case 'user': {
      const origin = internalMessageOrigin(message);
      return [
        input(
          id,
          time,
          origin === undefined || origin === 'subagent-report',
          origin === undefined
            ? { kind: SEED_SOURCE_KIND.user }
            : { kind: SEED_SOURCE_KIND.piInternal, origin },
          userBlocks(message.content)
        ),
      ];
    }
    case 'assistant':
      return [piAssistant(message, id, time, counts)];
    case 'toolResult': {
      const content = userBlocks(message.content);
      const isError = message.isError === true;
      const recovered =
        isError &&
        content.length === 1 &&
        content[0]?.type === 'text' &&
        content[0].text === LEGACY_RECOVERED_RESULT_TEXT;
      return [
        {
          kind: 'result',
          id,
          time,
          callId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
          content,
          isError,
          ...(recovered
            ? { error: { name: 'LegacyInterrupted', code: 'TOOL_OUTCOME_UNKNOWN' } }
            : {}),
          ...(message.details !== undefined
            ? { meta: { aiclient: { piDetails: plainJson(message.details) } } }
            : {}),
          orphan: {
            kind: 'ignorable',
            time,
            type: SEED_EVENT_TYPE.piEntry,
            data: { entryId: id, message: plainJson(message) },
          },
        },
      ];
    }
    case 'custom':
      return [
        input(
          id,
          time,
          false,
          { kind: SEED_SOURCE_KIND.piCustom, customType: message.customType },
          userBlocks(message.content)
        ),
      ];
    case 'bashExecution':
      if (message.excludeFromContext) {
        counts.excludedFromContext += 1;
        return [];
      }
      return [textInput(id, time, SEED_SOURCE_KIND.piBash, bashExecutionToText(message))];
    case 'branchSummary':
      return [
        textInput(
          id,
          time,
          SEED_SOURCE_KIND.piBranchSummary,
          BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX
        ),
      ];
    case 'compactionSummary':
      return [
        textInput(
          id,
          time,
          SEED_SOURCE_KIND.piCompactionSummary,
          COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX
        ),
      ];
    default:
      return [];
  }
}

/**
 * Where pi's kept tail starts, as candidate entry ids in branch order.
 *
 * The explicit anchor first (`firstKeptEntryId`, written by the CLI, by the
 * v1 converter and by 1.0.x's `appendCompaction`; PI-Desktop's
 * `throughMessageId` names the entry before it). Without one, 1.0.x's own
 * rule (`store.ts` `compactionAnchor`): the branch message with the retained
 * message's role and timestamp, when exactly one matches — tried for each
 * retained message in turn, so a head that never was on this branch does not
 * cost the rest.
 */
function anchorsOf(entry: CompactionEntry, before: readonly Entry[]): string[] {
  const retained = entry.retainedTail;
  if (retained.length === 0) return [];
  const raw = entry as unknown as Row;
  let from =
    typeof raw.firstKeptEntryId === 'string'
      ? before.findIndex((item) => item.id === raw.firstKeptEntryId)
      : -1;
  if (from < 0 && typeof raw.throughMessageId === 'string') {
    const through = before.findIndex((item) => item.id === raw.throughMessageId);
    if (through >= 0) from = through + 1;
  }
  for (let index = 0; from < 0 && index < retained.length; index += 1) {
    const kept = retained[index];
    const matches = before.flatMap((item, position) =>
      item.type === 'message' &&
      item.message.role === kept?.role &&
      item.message.timestamp === kept?.timestamp
        ? [position]
        : []
    );
    if (matches.length === 1) from = matches[0] as number;
  }
  return from < 0 ? [] : before.slice(from).map((item) => item.id);
}

function checkpointItem(entry: CompactionEntry, before: readonly Entry[]): IrCheckpoint {
  const retained = Array.isArray(entry.retainedTail) ? entry.retainedTail : [];
  const userOnly = retained.length > 0 && retained.every((message) => message.role === 'user');
  return {
    kind: 'checkpoint',
    id: entry.id,
    time: entry.timestamp,
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    retainedCount: retained.length,
    anchors: anchorsOf({ ...entry, retainedTail: retained }, before),
    ...(userOnly
      ? {
          retainedUserCopies: retained.map((message) =>
            userBlocks((message as { content?: unknown }).content)
          ),
        }
      : {}),
  };
}

function customItems(entry: CustomEntry, counts: PiIrCounts): IrItem[] {
  const type = entry.customType;
  const time = entry.timestamp;
  if (PERMISSION_RECORDS.has(type) || type === CLI_BOOKKEEPING_TYPE || type.startsWith('pi-cli:')) {
    counts.bookkeeping += 1;
    return [];
  }
  if (type === RUN_STOP_CUSTOM_TYPE) {
    const cause = recordOf(entry.data)?.cause;
    if (cause === 'user_stop' || cause === 'interjected') return [{ kind: 'stop', time, cause }];
    counts.bookkeeping += 1;
    return [];
  }
  const data = plainJson(entry.data);
  const record = recordOf(data) as { [key: string]: SeedJson } | undefined;
  const ignorable = (eventType: string, payload: SeedJson): IrIgnorable => ({
    kind: 'ignorable',
    time,
    type: eventType,
    data: payload,
  });
  // Own records keep their shape (the projection reads it), plus the entry id
  // a projection needs to mint the row id the preview used.
  if (record && type === LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE)
    return [ignorable(SEED_EVENT_TYPE.legacyProvenance, { ...record, entryId: entry.id })];
  if (record && type === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY)
    return [ignorable(SEED_EVENT_TYPE.legacyDisplay, { ...record, entryId: entry.id })];
  if (record && type === SUBAGENT_RECORD)
    return [ignorable(SEED_EVENT_TYPE.piSubagent, { ...record, entryId: entry.id })];
  return [
    ignorable(SEED_EVENT_TYPE.piEntry, {
      entryId: entry.id,
      customType: type,
      ...(entry.data !== undefined ? { data } : {}),
    }),
  ];
}

/** The active branch of `document` as seed items, plus what the sidecar and resume need. */
export function piSessionIr(document: SessionDocument): PiIr {
  const branch = branchEntries(document);
  const onBranch = new Set(branch.map((entry) => entry.id));
  const labels = document.labels ?? {};
  const counts: PiIrCounts = {
    bookkeeping: 0,
    labels: 0,
    offBranchLabels: Object.keys(labels).filter((id) => !onBranch.has(id)).length,
    excludedFromContext: 0,
    emptySummaries: 0,
    droppedBlocks: 0,
    strippedToolCalls: 0,
    errorReplyBodies: 0,
    interruptedReplies: 0,
    replayStateOmitted: 0,
  };
  const items: IrItem[] = [];
  let lastTime = document.header.createdAt;
  branch.forEach((entry, index) => {
    const time = entry.timestamp;
    lastTime = Math.max(lastTime, time);
    switch (entry.type) {
      case 'message':
        items.push(...messageItems(entry.id, time, entry.message, counts));
        break;
      case 'compaction':
        items.push(checkpointItem(entry, branch.slice(0, index)));
        break;
      case 'branch_summary':
        // pi's context builder skips an empty one (`sessionEntryToContextMessages`).
        if (entry.summary) {
          items.push(
            textInput(
              entry.id,
              time,
              SEED_SOURCE_KIND.piBranchSummary,
              BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX
            )
          );
        } else counts.emptySummaries += 1;
        break;
      case 'custom':
        items.push(...customItems(entry, counts));
        break;
      default:
        // model_change, thinking_level_change, active_tools_change.
        counts.bookkeeping += 1;
    }
    const label = labels[entry.id];
    if (typeof label === 'string') {
      counts.labels += 1;
      items.push({
        kind: 'ignorable',
        time,
        type: SEED_EVENT_TYPE.piLabel,
        data: { targetMessageId: entry.id, label },
      });
    }
  });
  // A run the SDK started and never finished; compaction and navigation
  // operations leave the conversation as it was.
  if (document.unfinished?.some((operation) => (operation.intent ?? 'run') === 'run'))
    items.push({ kind: 'crash', time: lastTime });
  const grants = restoredGrants(branch);
  return {
    items,
    counts,
    branch,
    grants: grants.length > 0 ? encodeGrants(grants) : null,
    legacyPermissions: sessionPermissions(branch, document.header.metadata?.permissions) ?? null,
  };
}

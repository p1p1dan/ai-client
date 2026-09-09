import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { buildSessionContext, type Entry, type JsonlV4Header } from '@earendil-works/pi-agent-core';
import {
  isRuntimePermissionSettings,
  type LegacyPermissionTier,
  migratePermissionTier,
  type RuntimePermissionSettings,
} from '../../../shared/types/runtimePermission.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';
import { branchEntries, decodeSession } from './codec.ts';
import type { SessionConfig } from './store.ts';

export const PERMISSIONS_ENTRY = 'aiclient.permissions';
const TIERS = new Set(['readonly', 'pragmatic', 'handsoff', 'fullopen']);
export function migratedPermissions(value: unknown): RuntimePermissionSettings | undefined {
  if (isRuntimePermissionSettings(value)) return value;
  if (typeof value === 'string' && TIERS.has(value))
    return migratePermissionTier(value as LegacyPermissionTier);
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return migratedPermissions(row.permissions ?? row.tier ?? row.permissionTier);
  }
  return undefined;
}
export function sessionPermissions(entries: readonly Entry[], fallback?: unknown) {
  let permissions = migratedPermissions(fallback);
  for (const entry of entries) {
    if (
      entry.type === 'custom' &&
      [PERMISSIONS_ENTRY, 'aiclient-session-tier', 'permission-tier'].includes(entry.customType)
    )
      permissions = migratedPermissions(entry.data) ?? permissions;
  }
  return permissions;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeHostError('session_legacy_invalid', 'expected a legacy object');
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): number {
  const time =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time))
    throw new RuntimeHostError('session_legacy_invalid', 'invalid legacy timestamp');
  return time;
}
function lines(content: string) {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      return [record(JSON.parse(line))];
    } catch (error) {
      if (i === lines.length - 1 && !content.endsWith('\n') && error instanceof SyntaxError)
        return [];
      throw error;
    }
  });
}

export function convertLegacySession(
  content: string,
  cwd: string,
  sourceFile: string,
  allowRelocate = false
): string {
  const rows = lines(content);
  const first = rows[0];
  if (!first || first.type !== 'session')
    throw new RuntimeHostError('session_format_unsupported', 'missing legacy session header');
  if (first.schema !== undefined && first.schema !== 1)
    throw new RuntimeHostError('session_format_unsupported', 'unsupported desktop session schema');
  const originalHeader = structuredClone(first);
  if (first.schema !== 1) {
    const version = first.version ?? 1;
    if (![1, 2, 3].includes(Number(version)))
      throw new RuntimeHostError('session_format_unsupported', 'unsupported Pi session version');
    if (version === 1) {
      let parent: string | null = null;
      for (let index = 1; index < rows.length; index++) {
        rows[index].id = createHash('sha256')
          .update(`${sourceFile}:${index}`)
          .digest('hex')
          .slice(0, 16);
        rows[index].parentId = parent;
        parent = rows[index].id as string;
      }
      for (const row of rows)
        if (row.type === 'compaction' && typeof row.firstKeptEntryIndex === 'number')
          row.firstKeptEntryId = rows[row.firstKeptEntryIndex]?.id;
    }
    if (Number(version) < 3)
      for (const row of rows) {
        if (row.type === 'message' && record(row.message).role === 'hookMessage')
          record(row.message).role = 'custom';
      }
    first.version = 3;
  }
  const sourceCwd = typeof first.cwd === 'string' ? first.cwd : undefined;
  const initialPermissions = migratedPermissions(
    first.permissions ?? first.permissionTier ?? first.tier ?? first.metadata
  );
  if (sourceCwd && resolve(sourceCwd) !== resolve(cwd) && !allowRelocate)
    throw new RuntimeHostError(
      'session_cwd_mismatch',
      'legacy workspace relocation must be explicit'
    );
  const header: JsonlV4Header = {
    kind: 'header',
    version: 4,
    id: randomUUID(),
    cwd,
    createdAt: timestamp(first.timestamp ?? first.createdAt),
    metadata: {
      importedFrom: sourceFile,
      sourceSha256: createHash('sha256').update(content).digest('hex'),
      sourceSessionId: String(first.id ?? first.sessionId),
      sourceFormat: first.version === 3 ? `pi-v${originalHeader.version ?? 1}` : 'pi-desktop-1',
      ...(sourceCwd ? { sourceCwd } : {}),
      legacyHeader: JSON.parse(JSON.stringify(originalHeader)),
      ...(initialPermissions ? { permissions: { ...initialPermissions } } : {}),
    },
  };
  const entries: Entry[] = [];
  const ids = new Set<string>();
  let leafId: string | null = null;
  const output: Record<string, unknown>[] = [{ ...header }];
  let seq = 0;
  const append = (value: Record<string, unknown>) => {
    if (
      typeof value.id !== 'string' ||
      ids.has(value.id) ||
      (value.parentId !== null && (typeof value.parentId !== 'string' || !ids.has(value.parentId)))
    )
      throw new RuntimeHostError(
        'session_legacy_invalid',
        'duplicate entry or missing legacy parent'
      );
    ids.add(value.id);
    const item = { ...value, seq: ++seq } as unknown as Entry;
    entries.push(item);
    leafId = item.id;
    output.push({ kind: 'entry', ...item });
  };
  const base = (row: Record<string, unknown>) => ({
    id: String(row.id ?? randomUUID()),
    timestamp: timestamp(row.timestamp ?? row.createdAt),
    parentId: first.version === 3 ? (row.parentId ?? null) : leafId,
  });
  for (const row of rows.slice(1)) {
    const common = base(row);
    if (row.type === 'message') {
      if (first.version === 3)
        append({
          ...row,
          ...common,
          message: {
            ...record(row.message),
            timestamp: timestamp(record(row.message).timestamp ?? common.timestamp),
          },
        });
      else {
        const meta = record(row.meta ?? {});
        if (meta.parentToolCallId) {
          append({ ...common, type: 'custom', customType: 'legacy:subagent', data: row });
          continue;
        }
        if (row.role === 'tool') {
          const blocks = Array.isArray(row.blocks) ? row.blocks.map(record) : [];
          const call = blocks.find((block) => block.type === 'tool_call');
          if (!call || typeof call.callId !== 'string' || typeof call.name !== 'string')
            throw new RuntimeHostError(
              'session_legacy_invalid',
              'desktop tool row has no call identity'
            );
          let carrier = entries.findLast(
            (entry) =>
              entry.type === 'message' &&
              (entry.message.role === 'assistant' || entry.message.role === 'user')
          );
          if (!carrier || carrier.type !== 'message' || carrier.message.role !== 'assistant') {
            append({
              ...common,
              id: `${common.id}:carrier`,
              type: 'message',
              message: desktopMessage({ ...row, role: 'assistant', blocks: [] }),
            });
            carrier = entries.at(-1);
          }
          if (carrier?.type === 'message' && carrier.message.role === 'assistant') {
            if (
              !carrier.message.content.some(
                (block) => block.type === 'toolCall' && block.id === call.callId
              )
            )
              carrier.message.content.push({
                type: 'toolCall',
                id: call.callId,
                name: call.name,
                arguments: record(call.args ?? {}),
              });
            carrier.message.stopReason = 'toolUse';
          }
          common.parentId = leafId;
        }
        append({ ...common, type: 'message', message: desktopMessage(row), legacyRecord: row });
      }
    } else if (row.type === 'compaction') {
      const before =
        first.version === 3 ? common.parentId : (row.throughMessageId ?? common.parentId);
      const path = branchEntries({ header, entries, leafId: before as string | null, seq });
      const keptId = row.firstKeptEntryId ?? row.firstKeptMessageId;
      const keptIndex = path.findIndex((entry) => entry.id === keptId);
      if (!Array.isArray(row.retainedTail) && keptId && keptIndex < 0)
        throw new RuntimeHostError(
          'session_legacy_invalid',
          'compaction retained anchor is missing'
        );
      const retainedTail = Array.isArray(row.retainedTail)
        ? [...row.retainedTail]
        : keptIndex >= 0
          ? buildSessionContext(path.slice(keptIndex)).messages
          : [];
      if (first.schema === 1 && row.throughMessageId) {
        const currentPath = branchEntries({ header, entries, leafId, seq });
        const through = currentPath.findIndex((entry) => entry.id === row.throughMessageId);
        if (through < 0)
          throw new RuntimeHostError(
            'session_legacy_invalid',
            'desktop compaction boundary is missing'
          );
        retainedTail.push(
          ...currentPath
            .slice(through + 1)
            .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
        );
      }
      append({
        ...row,
        ...common,
        type: 'compaction',
        summary: row.summary,
        retainedTail,
        tokensBefore: row.tokensBefore,
      });
    } else if (row.type === 'custom_message') {
      append({
        ...common,
        type: 'message',
        message: {
          role: 'custom',
          customType: row.customType,
          content: row.content,
          display: row.display,
          details: row.details,
          timestamp: common.timestamp,
        },
      });
    } else if (
      [
        'model_change',
        'thinking_level_change',
        'active_tools_change',
        'branch_summary',
        'custom',
      ].includes(String(row.type))
    ) {
      append({ ...row, ...common });
    } else {
      append({ ...common, type: 'custom', customType: `legacy:${String(row.type)}`, data: row });
    }
    if (row.type === 'session_info' && typeof row.name === 'string')
      output.push({ kind: 'fact', fact: 'name', name: row.name, seq: ++seq });
    if (row.type === 'label')
      output.push({
        kind: 'fact',
        fact: 'label',
        targetId: row.targetId,
        label: row.label,
        seq: ++seq,
      });
  }
  const permissions = sessionPermissions(
    branchEntries({ header, entries, leafId, seq }),
    first.permissions ?? first.permissionTier ?? first.tier ?? record(first.metadata ?? {})
  );
  if (permissions)
    append({
      type: 'custom',
      customType: PERMISSIONS_ENTRY,
      data: permissions,
      id: randomUUID(),
      timestamp: Date.now(),
      parentId: leafId,
    });
  output.push({ kind: 'lane', lane: 'main', leafId, seq: ++seq });
  const result = `${output.map((row) => JSON.stringify(row)).join('\n')}\n`;
  decodeSession(result);
  return result;
}

function desktopUsage(value: unknown) {
  const usage = record(value ?? {});
  const number = (key: string, alternate: string) =>
    typeof usage[key] === 'number'
      ? usage[key]
      : typeof usage[alternate] === 'number'
        ? usage[alternate]
        : 0;
  const input = number('input', 'inputTokens');
  const output = number('output', 'outputTokens');
  const cacheRead = number('cacheRead', 'cacheReadTokens');
  const cacheWrite = number('cacheWrite', 'cacheWriteTokens');
  return {
    ...usage,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens:
      typeof usage.totalTokens === 'number'
        ? usage.totalTokens
        : input + output + cacheRead + cacheWrite,
    cost: usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// PI-Desktop's canonical block record, adapted from transcripts.rs and its
// transcript -> model projection. Unknown blocks remain in legacyRecord.
function desktopMessage(row: Record<string, unknown>): Record<string, unknown> {
  const meta = record(row.meta ?? {});
  const blocks = Array.isArray(row.blocks) ? row.blocks.map(record) : [];
  const time = timestamp(row.createdAt);
  const content = blocks.flatMap((block): Record<string, unknown>[] => {
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text ?? '' }];
      case 'thinking':
        return [{ type: 'thinking', thinking: block.thinking ?? block.text ?? '' }];
      case 'tool_call':
        return [
          {
            type: 'toolCall',
            id: block.callId ?? block.toolCallId ?? block.id,
            name: block.name ?? block.toolName,
            arguments: block.args ?? block.input ?? block.arguments ?? {},
          },
        ];
      case 'image':
        return [block];
      case 'attachment': {
        const attachment = record(block.attachment ?? block);
        return attachment.data && attachment.mediaType
          ? [{ type: 'image', data: attachment.data, mimeType: attachment.mediaType }]
          : [
              {
                type: 'text',
                text: `[Attachment: ${String(attachment.name ?? attachment.path ?? 'unavailable')}]`,
              },
            ];
      }
      default:
        return [];
    }
  });
  if (row.role === 'user') return { role: 'user', content, timestamp: time };
  if (row.role === 'assistant')
    return {
      role: 'assistant',
      content,
      timestamp: time,
      api: meta.api ?? 'openai-completions',
      provider: meta.providerId ?? 'legacy',
      model: meta.modelId ?? 'legacy',
      stopReason:
        row.isError || meta.status === 'error' || meta.error
          ? 'error'
          : (meta.stopReason ?? (content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop')),
      usage: desktopUsage(meta.usage),
    };
  if (row.role === 'tool' || row.role === 'toolResult') {
    const block = blocks.find((b) => b.type === 'tool_call') ?? {};
    const result = block.result;
    const toolContent =
      result && typeof result === 'object' && 'content' in result
        ? result.content
        : [
            {
              type: 'text',
              text:
                typeof result === 'string' ? result : JSON.stringify(result ?? block.text ?? ''),
            },
          ];
    return {
      role: 'toolResult',
      timestamp: time,
      toolCallId: block.callId ?? meta.toolCallId ?? row.id,
      toolName: row.toolName ?? block.name ?? meta.toolName ?? 'unknown',
      isError: row.isError === true || block.isError === true,
      content: toolContent,
    };
  }
  return {
    role: 'custom',
    customType: String(meta.customType ?? row.role),
    content,
    display: true,
    timestamp: time,
  };
}

export async function prepareSessionConfig(
  io: RuntimeHostIoService,
  config: SessionConfig
): Promise<SessionConfig> {
  if (config.mode === 'create') return config;
  const sourceFile = await io.realpath(resolve(config.sourceFile ?? config.file));
  const read = await io.readFile(sourceFile, {
    maxBytes: config.maxBytes ?? 32 * 1024 * 1024,
    overflow: 'error',
  });
  const content = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes, {
    stream: read.bytes.at(-1) !== 10,
  });
  const first = record(JSON.parse(content.split('\n').find((line) => line.trim()) ?? ''));
  if (config.mode === 'resume' && first?.kind === 'header' && first.version === 4) return config;
  const requested =
    config.mode === 'import' ? resolve(config.file) : `${sourceFile}.native-v4.jsonl`;
  await io.mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  let file = join(await io.realpath(dirname(requested)), basename(requested));
  try {
    file = await io.realpath(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (file === sourceFile)
    throw new RuntimeHostError(
      'session_import_same_file',
      'import destination must differ from source'
    );
  const converted = convertLegacySession(
    content,
    await io.realpath(config.cwd),
    sourceFile,
    config.allowWorkspaceRelocation
  );
  if (Buffer.byteLength(converted) > (config.maxBytes ?? 32 * 1024 * 1024))
    throw new RuntimeHostError('session_size_limit', 'converted session exceeds size budget');
  const lock = `${file}.writer.lock`;
  try {
    await io.writeFile(
      lock,
      Buffer.from(JSON.stringify({ pid: process.pid, token: randomUUID() })),
      { createOnly: true, mode: 0o600 }
    );
  } catch (error) {
    if (errorCode(error) === 'EEXIST')
      throw new RuntimeHostError('session_locked', `session already has a writer: ${file}`);
    throw error;
  }
  try {
    let exists = true;
    try {
      await io.stat(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await io.writeFile(temporary, Buffer.from(converted), { createOnly: true, mode: 0o600 });
        await io.rename(temporary, file);
      } finally {
        await io.unlink(temporary).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
      return { ...config, file, mode: 'resume' };
    }
    if (config.mode === 'import')
      throw new RuntimeHostError('EEXIST', 'import destination already exists');
    const previous = decodeSession(
      new TextDecoder().decode(
        (
          await io.readFile(file, {
            maxBytes: config.maxBytes ?? 32 * 1024 * 1024,
            overflow: 'error',
          })
        ).bytes
      )
    );
    if (
      previous.header.metadata?.importedFrom !== sourceFile ||
      previous.header.metadata?.sourceSha256 !== createHash('sha256').update(content).digest('hex')
    )
      throw new RuntimeHostError(
        'session_import_source_changed',
        'legacy source changed since the native copy was created'
      );
  } finally {
    await io.unlink(lock);
  }
  return { ...config, file, mode: 'resume' };
}

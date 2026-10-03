import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  branchEntries,
  decodeSession,
  isSuccessfulMessage,
  type SessionDocument,
} from '../codec.ts';
import { buildSessionContext } from '../context.ts';
import { convertLegacySession, firstRow, sessionPermissions } from '../legacy.ts';
import { projectPiSessionHistory } from '../timeline.ts';
import { buildPiSessionTreeSnapshot } from '../tree.ts';
import type { AgentMessage, Entry } from '../types.ts';

/**
 * dsh-rebase P1-9g — the legacy pi corpus, decoded by the shared library.
 *
 * Every file under `fixtures/legacy-pi/` is what 1.0.x (or a writer it shared
 * files with) left on disk; `scripts/gen-legacy-pi-fixtures.ts` made them with
 * the real writers and synthetic conversations (that script went with
 * `src/runtime` in dsh-rebase P1-12 step 3; see the corpus README). The golden next to each one is
 * this library's reading of it: whether the strict (1.0.x) decode refuses, the
 * whole document under `tolerateUnfinished`, the active branch, the model
 * context pi would build from it, the restored permissions, and the history
 * and tree projections the preview draws. A change to any of those is a change
 * to what the migration will read, which is why they are pinned here.
 *
 * Re-record at closeout only:
 *   AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run src/shared/legacyPiSession/__tests__/legacyPiCorpus.test.ts
 *   pnpm exec biome format --write src/shared/__tests__/fixtures/legacy-pi
 */

interface ManifestEntry {
  file: string;
  generation: string;
  writer: string;
  read: 'v4' | 'legacy' | 'bytes';
  sourcePath: string;
  cwd: string;
  covers: string[];
  derivedFrom?: string;
  copyOf?: string;
}

const CORPUS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../__tests__/fixtures/legacy-pi'
);
const GOLDEN = path.join(CORPUS, 'golden');
const UPDATE = Boolean(process.env.AICLIENT_UPDATE_FIXTURES);
const manifest = (
  JSON.parse(readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8')) as {
    files: ManifestEntry[];
  }
).files;

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The readers' rule: fatal UTF-8, and a tail cut mid-character reads as a torn row. */
function text(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
    stream: bytes.at(-1) !== 10,
  });
}

function failure(error: unknown) {
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  return {
    code: typeof value.code === 'string' ? value.code : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    message: typeof value.message === 'string' ? value.message : String(error),
  };
}

/** What the migration will inject: ids and time that depend on nothing but the call order. */
function deterministic() {
  let next = 0;
  return {
    newId: () => `golden-${String(++next).padStart(4, '0')}`,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: { type?: string; text?: string }) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('');
}

/** One line per message the model would be sent, enough to see what changed. */
function contextSummary(messages: readonly AgentMessage[]) {
  return messages.map((message) => {
    switch (message.role) {
      case 'user': {
        const internal = (message as { aiclientInternal?: unknown }).aiclientInternal;
        const images = Array.isArray(message.content)
          ? message.content.filter((block) => block.type === 'image').length
          : 0;
        return {
          role: message.role,
          text: textOf(message.content),
          ...(images ? { images } : {}),
          ...(typeof internal === 'string' ? { internal } : {}),
        };
      }
      case 'assistant':
        return {
          role: message.role,
          stopReason: message.stopReason,
          blocks: message.content.map((block) =>
            block.type === 'toolCall' ? `toolCall:${block.name}:${block.id}` : block.type
          ),
        };
      case 'toolResult':
        return {
          role: message.role,
          toolCallId: message.toolCallId,
          isError: message.isError,
        };
      case 'custom':
        return {
          role: message.role,
          customType: message.customType,
          text: textOf(message.content),
        };
      case 'bashExecution':
        return { role: message.role, command: message.command };
      default:
        return { role: message.role, summary: message.summary };
    }
  });
}

/** The store's projection adapter: epoch timestamps rendered as ISO strings. */
const projected = (entries: readonly Entry[]) =>
  entries.map((entry) => ({ ...entry, timestamp: new Date(entry.timestamp).toISOString() }));

function readDocument(document: SessionDocument, file: string) {
  const branch = branchEntries(document);
  // `JsonlSessionStore.snapshotAt`: failed replies never reach the model.
  const clean = branch.filter(
    (item) => item.type !== 'message' || isSuccessfulMessage(item.message)
  );
  const context = buildSessionContext(clean);
  return {
    document: {
      header: document.header,
      seq: document.seq,
      leafId: document.leafId,
      ...(document.name !== undefined ? { name: document.name } : {}),
      ...(document.labels ? { labels: document.labels } : {}),
      ...(document.skipped ? { skipped: document.skipped } : {}),
      ...(document.unfinished ? { unfinished: document.unfinished } : {}),
      ...(document.repair !== undefined
        ? { repair: { bytes: Buffer.byteLength(document.repair), sha256: sha256(document.repair) } }
        : {}),
      entries: document.entries,
    },
    branch: branch.map((entry) => entry.id),
    context: {
      model: context.model,
      thinkingLevel: context.thinkingLevel,
      messages: contextSummary(context.messages.filter(isSuccessfulMessage)),
    },
    permissions: sessionPermissions(branch, document.header.metadata?.permissions) ?? null,
    history: projectPiSessionHistory({ getBranch: () => projected(branch) }),
    tree: buildPiSessionTreeSnapshot({
      manager: {
        getEntries: () => projected(document.entries),
        getBranch: () => projected(branch),
        getLeafId: () => document.leafId,
        getLabel: (id) => document.labels?.[id],
      },
      logicalSessionId: 'golden',
      sessionFile: file,
      workspacePath: document.header.cwd,
    }),
  };
}

function golden(entry: ManifestEntry): Record<string, unknown> {
  const bytes = readFileSync(path.join(CORPUS, entry.file));
  const result: Record<string, unknown> = {
    file: entry.file,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
  let content: string;
  try {
    content = text(bytes);
  } catch (error) {
    return { ...result, unreadable: { stage: 'utf-8', code: failure(error).code } };
  }
  try {
    firstRow(content, entry.file);
  } catch (error) {
    return { ...result, unreadable: { stage: 'first-row', ...failure(error) } };
  }
  let native = content;
  if (entry.read === 'legacy') {
    try {
      native = convertLegacySession(content, entry.cwd, entry.sourcePath, true, deterministic());
    } catch (error) {
      return { ...result, unreadable: { stage: 'convert', ...failure(error) } };
    }
  }
  let strict: unknown = 'ok';
  try {
    decodeSession(native);
  } catch (error) {
    strict = failure(error);
  }
  try {
    return {
      ...result,
      strict,
      ...readDocument(decodeSession(native, { tolerateUnfinished: true }), entry.file),
    };
  } catch (error) {
    return { ...result, strict, tolerant: failure(error) };
  }
}

describe('the legacy pi corpus', () => {
  it('lists every file it holds, and holds every file it lists', () => {
    const onDisk = readdirSync(CORPUS)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    expect(manifest.map((entry) => entry.file).sort()).toEqual(onDisk);
    // Five generations plus the damaged derivatives, each actually present.
    expect(new Set(manifest.map((entry) => entry.generation))).toEqual(
      new Set([
        'pi-v1',
        'pi-v2',
        'pi-v3',
        'pi-desktop-1',
        'native-v4',
        'native-v4+cli',
        'native-v4-import',
        'damaged',
      ])
    );
  });

  it.each(
    manifest.map((entry) => [entry.file, entry] as const)
  )('decodes %s as its golden says', (_file, entry) => {
    const actual = golden(entry);
    const target = path.join(GOLDEN, `${entry.file}.golden.json`);
    if (UPDATE) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(target, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(readFileSync(target, 'utf8')));
  });

  it('has no golden without a corpus file', () => {
    const goldens = readdirSync(GOLDEN).filter((name) => name.endsWith('.golden.json'));
    expect(goldens.sort()).toEqual(manifest.map((entry) => `${entry.file}.golden.json`).sort());
  });
});

describe('the corpus agrees with the 1.0.x copy rule', () => {
  const copies = manifest.filter((entry) => entry.copyOf);

  it('pairs every legacy source with the copy 1.0.x made beside it', () => {
    expect(copies.map((entry) => entry.file).sort()).toEqual(
      manifest
        .filter((entry) => entry.read === 'legacy')
        .map((entry) => `${entry.file}.native-v4.jsonl`)
        .sort()
    );
  });

  it.each(
    copies.map((entry) => [entry.file, entry] as const)
  )('%s names its source, and its hash matches unless the source drifted', (_file, copy) => {
    const source = manifest.find((entry) => entry.file === copy.copyOf) as ManifestEntry;
    const header = decodeSession(text(readFileSync(path.join(CORPUS, copy.file)))).header;
    expect(header.metadata?.importedFrom).toBe(source.sourcePath);
    const matches =
      header.metadata?.sourceSha256 === sha256(readFileSync(path.join(CORPUS, source.file)));
    expect(matches).toBe(!source.file.includes('drifted'));
  });

  it.each(
    copies.filter((entry) => !entry.file.includes('drifted')).map((e) => [e.file, e] as const)
  )('%s holds what the shared converter makes of its source', (_file, copy) => {
    const source = manifest.find((entry) => entry.file === copy.copyOf) as ManifestEntry;
    const converted = decodeSession(
      convertLegacySession(
        text(readFileSync(path.join(CORPUS, source.file))),
        source.cwd,
        source.sourcePath,
        true,
        deterministic()
      )
    );
    const written = decodeSession(text(readFileSync(path.join(CORPUS, copy.file))));
    // Ids the converter minted differ run to run; everything carried over from
    // the source must come out identical, in the same order.
    const carried = (document: SessionDocument) =>
      document.entries.filter((entry) => !entry.id.startsWith('golden-'));
    const expected = carried(converted);
    expect(written.entries.slice(0, expected.length)).toEqual(expected);
    expect(written.name).toEqual(converted.name);
    expect(written.labels).toEqual(converted.labels);
    const { id: _written, ...writtenHeader } = written.header;
    const { id: _converted, ...convertedHeader } = converted.header;
    expect(writtenHeader).toEqual(convertedHeader);
  });
});

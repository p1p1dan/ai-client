/**
 * H/20 — one session file, two readers.
 *
 * Both sides here are the real implementations: `SessionManager` is the parser
 * behind `pi --session <file>`, and `JsonlSessionStore` is what the GUI worker
 * writes. Stubbing either would only prove that our idea of the other format is
 * self-consistent, which is precisely what was wrong before this landed.
 *
 * This is the only file under `src/runtime` that imports pi-coding-agent, and
 * it does so as the subject under test, not as a dependency of the runtime:
 * what is being pinned is that the CLI, a writer we do not control, can share a
 * file with us in both directions.
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentMessage, CompactResult } from '@earendil-works/pi-agent-core';
import { Context } from 'cordis';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeHostIoService } from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import { branchEntries, decodeSession } from '../plugins/session/codec.ts';
import { JsonlSessionStore } from '../plugins/session/store.ts';

/** The slice of pi-coding-agent's SessionManager this test drives. */
interface CliSession {
  buildSessionContext(): { messages: unknown[] };
  appendMessage(message: unknown): string;
  appendSessionInfo(name: string): string;
  appendLabelChange(targetId: string, label: string | undefined): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(customType: string, content: string, display: boolean): string;
  appendThinkingLevelChange(level: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean
  ): string;
  getLeafId(): string | null;
}

/**
 * The CLI's session module, loaded by path.
 *
 * Not `import ... from '@earendil-works/pi-coding-agent'`: the package entry
 * pulls in its whole TUI module graph, which fails to link against the pi-tui
 * version installed here, and its `exports` map has no deep specifier. The file
 * URL sidesteps both while still running the CLI's real, shipped code — the
 * only thing that makes this test worth anything.
 */
let openCliSession: (file: string) => CliSession;

beforeAll(async () => {
  const module = (await import(
    pathToFileURL(
      resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')
    ).href
  )) as { SessionManager: { open(file: string): CliSession } };
  openCliSession = (file) => module.SessionManager.open(file);
});

let dir: string;
let ctx: Context;
let io: RuntimeHostIoService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'session-interop-'));
  ctx = new Context();
  await ctx.plugin(ExecPlugin, standaloneHost({}));
  const fiber = await ctx.plugin(HostIoPlugin, standaloneHost({}));
  await fiber.await();
  io = ctx.runtimeHostIo as RuntimeHostIoService;
});

afterEach(async () => {
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
});

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: Date.now() }) as unknown as AgentMessage;

const assistant = (text: string): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'anthropic-messages',
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  }) as unknown as AgentMessage;

/** Plain text of a conversation, whichever side produced the messages. */
function spoken(messages: readonly unknown[]): string[] {
  return messages.flatMap((value) => {
    const message = value as { role?: string; content?: unknown; summary?: string };
    const content = message.content;
    if (typeof content === 'string') return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      const part = block as { type?: string; text?: string };
      return part.type === 'text' && part.text !== undefined ? [part.text] : [];
    });
  });
}

async function open(file: string, mode: 'create' | 'resume') {
  return JsonlSessionStore.open(io, { file, cwd: dir, mode });
}

async function document(file: string) {
  return decodeSession(await readFile(file, 'utf8'));
}

const chat = () => join(dir, 'chat.jsonl');

describe('H/20 · the CLI reads what the GUI wrote', () => {
  it('carries a conversation through four alternating turns on one file', async () => {
    const file = chat();
    const store = await open(file, 'create');
    await store.appendMessage(user('GUI-1'));
    await store.appendMessage(assistant('GUI-1 reply'));
    await store.close();

    const cli = openCliSession(file);
    expect(spoken(cli.buildSessionContext().messages)).toEqual(['GUI-1', 'GUI-1 reply']);
    cli.appendMessage(user('TUI-1'));
    cli.appendMessage(assistant('TUI-1 reply'));

    const resumed = await open(file, 'resume');
    expect(spoken(resumed.snapshot().messages)).toEqual([
      'GUI-1',
      'GUI-1 reply',
      'TUI-1',
      'TUI-1 reply',
    ]);
    await resumed.appendMessage(user('GUI-2'));
    await resumed.close();

    // The CLI must chain onto OUR entry, not start a second root.
    const back = openCliSession(file);
    expect(spoken(back.buildSessionContext().messages)).toEqual([
      'GUI-1',
      'GUI-1 reply',
      'TUI-1',
      'TUI-1 reply',
      'GUI-2',
    ]);
  });

  it('stays readable to the CLI after a rename and a branch switch', async () => {
    // The rows that state a rename or a branch are not entries in v4, and one of
    // them is the last line of the file. Before H/20 the CLI took that trailing
    // row as the conversation's tip and showed an empty session.
    const file = chat();
    const store = await open(file, 'create');
    await store.appendMessage(user('first'));
    await store.appendMessage(assistant('first reply'));
    const first = store.snapshot().entries[0]?.id as string;
    await store.appendMessage(user('second'));
    await store.rename('renamed in the app');
    await store.navigate(first);
    await store.close();

    const cli = openCliSession(file);
    expect(spoken(cli.buildSessionContext().messages)).toEqual(['first']);

    cli.appendMessage(user('after the branch'));
    const doc = await document(file);
    expect(
      spoken(branchEntries(doc).map((entry) => (entry as { message?: unknown }).message))
    ).toEqual(['first', 'after the branch']);
    expect(doc.name).toBe('renamed in the app');
  });

  it('shows the CLI the tail a compaction retained', async () => {
    const file = chat();
    const store = await open(file, 'create');
    await store.appendMessage(user('old one'));
    await store.appendMessage(assistant('old reply'));
    await store.appendMessage(user('kept one'));
    await store.appendMessage(assistant('kept reply'));
    const result: CompactResult = {
      summary: 'summary of the old turns',
      tokensBefore: 1234,
      retainedTail: [user('kept one'), assistant('kept reply')],
    };
    await store.appendCompaction(result);
    await store.close();

    const cli = openCliSession(file);
    const spokenAfterCompaction = spoken(cli.buildSessionContext().messages);
    // Summary plus the retained tail — not the summarized turns, and not a
    // summary on its own (which is what the CLI falls back to with no anchor).
    expect(spokenAfterCompaction).toContain('kept one');
    expect(spokenAfterCompaction).toContain('kept reply');
    expect(spokenAfterCompaction).not.toContain('old one');
  });
});

describe('H/20 · the GUI reads what the CLI wrote', () => {
  it('accepts every row shape the CLI can append', async () => {
    const file = chat();
    const store = await open(file, 'create');
    await store.appendMessage(user('hello'));
    await store.appendMessage(assistant('hi'));
    const target = store.snapshot().entries[0]?.id as string;
    await store.close();

    const cli = openCliSession(file);
    cli.appendSessionInfo('renamed in the terminal');
    cli.appendLabelChange(target, 'bookmark');
    cli.appendCustomEntry('pi.extension', { restored: true });
    cli.appendCustomMessageEntry('pi.note', 'a note for the model', true);
    cli.appendThinkingLevelChange('high');
    cli.appendModelChange('anthropic', 'claude-sonnet-5');
    cli.appendMessage(user('after all that'));
    const leaf = cli.getLeafId();

    // A row type from a newer CLI than this one: unknown must not be fatal, and
    // must not sever the rows that come after it.
    await appendFile(
      file,
      `${JSON.stringify({
        type: 'invented_later',
        id: 'from-the-future',
        parentId: leaf,
        timestamp: new Date().toISOString(),
      })}\n${JSON.stringify({
        type: 'message',
        id: 'last-word',
        parentId: 'from-the-future',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'last word', timestamp: Date.now() },
      })}\n`
    );

    const doc = await document(file);
    expect(doc.name).toBe('renamed in the terminal');
    expect(doc.labels).toEqual({ [target]: 'bookmark' });
    const resumed = await open(file, 'resume');
    const messages = spoken(resumed.snapshot().messages);
    await resumed.close();
    expect(messages).toEqual([
      'hello',
      'hi',
      'a note for the model',
      'after all that',
      'last word',
    ]);
    // The extension's own bookkeeping entry is state, not conversation.
    expect(messages).not.toContain('pi.extension');
  });

  it('rebuilds the retained tail of a compaction the CLI wrote', async () => {
    const file = chat();
    const store = await open(file, 'create');
    await store.appendMessage(user('old one'));
    await store.appendMessage(assistant('old reply'));
    await store.appendMessage(user('kept one'));
    const kept = store.snapshot().entries.at(-1)?.id as string;
    await store.appendMessage(assistant('kept reply'));
    await store.close();

    const cli = openCliSession(file);
    cli.appendCompaction('summary from the terminal', kept, 4321, undefined, false);
    cli.appendMessage(user('after compaction'));

    const resumed = await open(file, 'resume');
    const snapshot = resumed.snapshot();
    await resumed.close();
    const checkpoint = snapshot.entries.findLast((entry) => entry.type === 'compaction');
    expect(checkpoint).toMatchObject({ summary: 'summary from the terminal', tokensBefore: 4321 });
    expect(spoken((checkpoint as { retainedTail: unknown[] }).retainedTail)).toEqual([
      'kept one',
      'kept reply',
    ]);
    expect(spoken(snapshot.messages)).toContain('after compaction');
  });

  it('refuses a CLI row whose parent is not in the file', async () => {
    const file = chat();
    const store = await open(file, 'create');
    await store.appendMessage(user('hello'));
    await store.close();
    await appendFile(
      file,
      `${JSON.stringify({
        type: 'message',
        id: 'orphan',
        parentId: 'nobody',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'orphan', timestamp: Date.now() },
      })}\n`
    );
    await expect(document(file)).rejects.toThrow(/duplicate id or missing parent/);
  });
});

describe('H/20 · sessions written before the dual header', () => {
  it('upgrades the header on resume and leaves every other line untouched', async () => {
    const file = chat();
    const header = {
      kind: 'header',
      version: 4,
      id: 'pre-h20',
      cwd: dir,
      createdAt: 1_700_000_000_000,
    };
    const entry = {
      kind: 'entry',
      lane: 'main',
      type: 'message',
      seq: 1,
      id: 'e1',
      parentId: null,
      timestamp: 1_700_000_000_001,
      message: { role: 'user', content: 'written before H/20', timestamp: 1_700_000_000_001 },
    };
    const body = `${JSON.stringify(entry)}\n`;
    await writeFile(file, `${JSON.stringify(header)}\n${body}`, { mode: 0o600 });

    expect(() => openCliSession(file)).toThrow(/not a valid pi session/);

    const store = await open(file, 'resume');
    await store.close();

    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'header', version: 4, type: 'session' });
    expect(`${lines.slice(1).join('\n')}`).toBe(body);
    expect(spoken(openCliSession(file).buildSessionContext().messages)).toEqual([
      'written before H/20',
    ]);
  });
});

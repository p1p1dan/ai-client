/**
 * TUI `/new` — the chat the sidebar cannot show.
 *
 * pi's `/new` cannot be disabled (the CLI matches the literal string with no
 * flag behind it) and reports its new session path nowhere in TUI mode, so the
 * only evidence this app can get is a file that appeared next to the one it
 * handed over. These tests pin that diff against a real temp directory: what
 * counts as new, what must never be reported, and the session index's veto.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { snapshotSessionDirectory, sweepStrandedSessions } from '../piTuiStrandedSessions';

function sessionDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ai-client-stranded-'));
}

function writeSession(directory: string, name: string): string {
  const file = join(directory, name);
  writeFileSync(file, '{"type":"session"}\n', 'utf8');
  return file;
}

it('reports a session file that appeared while the terminal ran', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');
  writeSession(directory, 'older-chat.jsonl');

  const snapshot = await snapshotSessionDirectory(chat);
  const created = writeSession(directory, '2026-09-18T10-00-00-000Z_new.jsonl');

  // The terminal's own file and everything that was already there stay out; a
  // `/new` session is the only thing left.
  expect(await sweepStrandedSessions(snapshot)).toEqual([created]);
});

it('says nothing when the terminal only wrote to the chat it was given', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');

  const snapshot = await snapshotSessionDirectory(chat);
  writeSession(directory, 'chat.jsonl');
  // Not a session file, so not a chat — the directory holds more than JSONL.
  writeFileSync(join(directory, 'notes.txt'), 'x', 'utf8');

  expect(await sweepStrandedSessions(snapshot)).toEqual([]);
});

it('leaves a chat the session index already knows alone', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');

  const snapshot = await snapshotSessionDirectory(chat);
  // The app writes its own chats into the same directory: one created in
  // another window while the terminal was open is in the sidebar already, and
  // announcing it as lost would be a false alarm.
  const indexed = writeSession(directory, 'gui-chat.jsonl');
  const stranded = writeSession(directory, 'tui-chat.jsonl');

  expect(
    await sweepStrandedSessions(snapshot, {
      isIndexed: async (file) => file === indexed,
    })
  ).toEqual([stranded]);
});

it('treats a session directory that does not exist yet as empty', async () => {
  const missing = join(sessionDirectory(), 'not-created-yet', 'chat.jsonl');

  const snapshot = await snapshotSessionDirectory(missing);

  expect(snapshot.before).toEqual([]);
  // A terminal must not fail — nor report anything — because pi has not created
  // its session directory yet.
  expect(await sweepStrandedSessions(snapshot)).toEqual([]);
});

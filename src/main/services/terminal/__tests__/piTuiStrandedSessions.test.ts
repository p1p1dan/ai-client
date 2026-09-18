/**
 * TUI `/new` — the chat the sidebar cannot show until something indexes it.
 *
 * pi's `/new` cannot be disabled (the CLI matches the literal string with no
 * flag behind it) and reports its new session path nowhere in TUI mode, so the
 * only evidence this app can get is a file that appeared next to the one it
 * handed over. These tests pin that diff against a real temp directory — what
 * counts as new, what must never be reported, the session index's veto — and
 * then what the file itself has to say before a row can point at it.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  readStrandedSessionIdentity,
  snapshotSessionDirectory,
  sweepStrandedSessions,
} from '../piTuiStrandedSessions';

/** The cwd the terminal was opened with — this app's spelling of the folder. */
const TERMINAL_CWD = '/repo';

function sessionDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'ai-client-stranded-'));
}

function writeSession(directory: string, name: string, rows: unknown[] = []): string {
  const file = join(directory, name);
  const content = [{ type: 'session', version: 3, id: 'pi-1', cwd: '/repo' }, ...rows]
    .map((row) => JSON.stringify(row))
    .join('\n');
  writeFileSync(file, `${content}\n`, 'utf8');
  return file;
}

/** Just the paths, for the cases that are about which files are picked up. */
function files(sessions: Array<{ file: string }>): string[] {
  return sessions.map((session) => session.file);
}

it('reports a session file that appeared while the terminal ran', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');
  writeSession(directory, 'older-chat.jsonl');

  const snapshot = await snapshotSessionDirectory(chat, TERMINAL_CWD);
  const created = writeSession(directory, '2026-09-18T10-00-00-000Z_new.jsonl');

  // The terminal's own file and everything that was already there stay out; a
  // `/new` session is the only thing left.
  expect(files(await sweepStrandedSessions(snapshot))).toEqual([created]);
});

it('says nothing when the terminal only wrote to the chat it was given', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');

  const snapshot = await snapshotSessionDirectory(chat, TERMINAL_CWD);
  writeSession(directory, 'chat.jsonl');
  // Not a session file, so not a chat — the directory holds more than JSONL.
  writeFileSync(join(directory, 'notes.txt'), 'x', 'utf8');

  expect(await sweepStrandedSessions(snapshot)).toEqual([]);
});

it('leaves a chat the session index already knows alone', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');

  const snapshot = await snapshotSessionDirectory(chat, TERMINAL_CWD);
  // The app writes its own chats into the same directory: one created in
  // another window while the terminal was open is in the sidebar already, and
  // announcing it as lost would be a false alarm.
  const indexed = writeSession(directory, 'gui-chat.jsonl');
  const stranded = writeSession(directory, 'tui-chat.jsonl');

  expect(
    files(
      await sweepStrandedSessions(snapshot, {
        isIndexed: async (file) => file === indexed,
      })
    )
  ).toEqual([stranded]);
});

it('treats a session directory that does not exist yet as empty', async () => {
  const missing = join(sessionDirectory(), 'not-created-yet', 'chat.jsonl');

  const snapshot = await snapshotSessionDirectory(missing, TERMINAL_CWD);

  expect(snapshot.before).toEqual([]);
  // A terminal must not fail — nor report anything — because pi has not created
  // its session directory yet.
  expect(await sweepStrandedSessions(snapshot)).toEqual([]);
});

/**
 * What the index row is built from. The workspace is the load-bearing field:
 * resuming the chat converts pi's v3 file to a v4 sibling, and that conversion
 * refuses (`session_cwd_mismatch`) unless the cwd it is given matches the one in
 * pi's own header — which is why it is read from the FILE and not taken from the
 * cwd the terminal was opened with.
 */
it('reads the workspace and the name out of the file itself', async () => {
  const directory = sessionDirectory();
  const chat = writeSession(directory, 'chat.jsonl');
  const snapshot = await snapshotSessionDirectory(chat, TERMINAL_CWD);
  const file = join(directory, '2026-09-18T10-00-00-000Z_new.jsonl');
  writeFileSync(
    file,
    [
      // pi moved to another folder mid-session (it offers that when a session's
      // cwd is gone), so the header disagrees with the terminal's own cwd.
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'pi-session-7',
        cwd: '/elsewhere/repo',
        timestamp: '2026-09-18T10:00:00.000Z',
      }),
      JSON.stringify({ type: 'session_info', name: 'first name' }),
      'not json at all',
      JSON.stringify({ type: 'session_info', name: 'renamed later' }),
    ].join('\n'),
    'utf8'
  );

  const [stranded] = await sweepStrandedSessions(snapshot);

  expect(stranded.identity).toEqual({
    piSessionId: 'pi-session-7',
    cwd: '/elsewhere/repo',
    // A rename appends a row rather than rewriting the first, so the last one
    // is the chat's current name. The unparsable line in between is skipped.
    title: 'renamed later',
    createdAt: Date.parse('2026-09-18T10:00:00.000Z'),
  });
  // Neither path resolves (they do not exist), so nothing PROVES they are one
  // directory and pi's answer stands — the one the resume gate checks against.
  expect(stranded.workspacePath).toBe('/elsewhere/repo');
});

/**
 * The same directory under two names. pi records the path its process resolved
 * to, so a repo opened through a symlink comes back spelled differently than the
 * folder this app registered — and the sidebar matches a row to a workspace by
 * comparing those strings, so pi's spelling would leave the chat indexed and
 * invisible. Resuming works either way (the runtime realpaths the cwd before it
 * compares), which is what makes the substitution safe.
 */
it("records the terminal's spelling when it is the same directory as pi's", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-client-stranded-link-')));
  const realRepo = join(root, 'real-repo');
  const linkedRepo = join(root, 'linked-repo');
  mkdirSync(realRepo);
  symlinkSync(realRepo, linkedRepo);
  const directory = join(root, 'sessions');
  mkdirSync(directory);
  const chat = writeSession(directory, 'chat.jsonl');

  // The terminal was opened on the symlink, the way the workspace is registered.
  const snapshot = await snapshotSessionDirectory(chat, linkedRepo);
  const file = join(directory, '2026-09-18T10-00-00-000Z_new.jsonl');
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session', version: 3, id: 'pi-8', cwd: realRepo })}\n`,
    'utf8'
  );

  const [stranded] = await sweepStrandedSessions(snapshot);

  expect(stranded.identity?.cwd).toBe(realRepo);
  expect(stranded.workspacePath).toBe(linkedRepo);
});

it("keeps pi's workspace when it is a different directory", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-client-stranded-link-')));
  const opened = join(root, 'opened-repo');
  const elsewhere = join(root, 'other-repo');
  mkdirSync(opened);
  mkdirSync(elsewhere);
  const directory = join(root, 'sessions');
  mkdirSync(directory);
  const chat = writeSession(directory, 'chat.jsonl');

  // Reverse check: pi really did move to another folder, and recording the
  // terminal's cwd would produce a row that cannot be resumed at all.
  const snapshot = await snapshotSessionDirectory(chat, opened);
  const file = join(directory, '2026-09-18T10-00-00-000Z_new.jsonl');
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session', version: 3, id: 'pi-9', cwd: elsewhere })}\n`,
    'utf8'
  );

  const [stranded] = await sweepStrandedSessions(snapshot);

  expect(stranded.workspacePath).toBe(elsewhere);
});

it('leaves an unnamed chat without a title rather than inventing one', async () => {
  const directory = sessionDirectory();
  const file = writeSession(directory, 'unnamed.jsonl');

  // The sidebar shows its own fallback for an empty title; guessing one here
  // would put a wrong name in the list that the user then has to correct.
  expect(await readStrandedSessionIdentity(file)).toMatchObject({ title: '', cwd: '/repo' });
});

it('marks a file it cannot identify instead of indexing it blind', async () => {
  const directory = sessionDirectory();

  const empty = join(directory, 'empty.jsonl');
  writeFileSync(empty, '', 'utf8');
  const truncated = join(directory, 'truncated.jsonl');
  writeFileSync(truncated, '{"type":"session","version":3,"id":"pi-2"', 'utf8');
  const noWorkspace = join(directory, 'no-cwd.jsonl');
  writeFileSync(noWorkspace, '{"type":"session","version":3,"id":"pi-3"}\n', 'utf8');
  const notASession = join(directory, 'other.jsonl');
  writeFileSync(notASession, '{"kind":"something-else"}\n', 'utf8');

  // No header, no workspace, no resume: the caller must fall back to naming the
  // file for the user, not write a row that fails the moment it is clicked.
  for (const file of [empty, truncated, noWorkspace, notASession]) {
    expect(await readStrandedSessionIdentity(file)).toBeNull();
  }
  expect(await readStrandedSessionIdentity(join(directory, 'missing.jsonl'))).toBeNull();
});

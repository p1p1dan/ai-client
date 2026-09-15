import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { samePiSessionPath } from '../piSessionPreflight.ts';

/**
 * All that is left of the pi session preflight (audit cutover-12, T028).
 *
 * The header scan, the JSON validation and the dev/ino identity check went with
 * the engine that needed them — the pi SDK's `SessionManager.open()` would
 * create a session for a missing or foreign path, and nothing hands it a path
 * any more. These cases cover the one helper the native runtime still imports,
 * `NativeWorkerRuntime.resume()`'s "is this the session I already have open?"
 * question, where a wrong answer means answering a request against the wrong
 * conversation.
 */

describe('samePiSessionPath', () => {
  it('sees through separator noise and relative segments', () => {
    const base = path.resolve('/repo/.pi/sessions');
    expect(
      samePiSessionPath(path.join(base, 'a.jsonl'), path.join(base, 'x', '..', 'a.jsonl'))
    ).toBe(true);
    expect(
      samePiSessionPath(path.join(base, 'a.jsonl'), `${path.join(base, 'a.jsonl')}${path.sep}`)
    ).toBe(true);
    // A path that does not exist yet still compares: pi writes the session file
    // lazily, so `resume` routinely asks about a file nobody has created.
    expect(
      samePiSessionPath(
        path.join(base, 'never-written.jsonl'),
        path.join(base, 'never-written.jsonl')
      )
    ).toBe(true);
  });

  it('keeps two different sessions apart', () => {
    const base = path.resolve('/repo/.pi/sessions');
    expect(samePiSessionPath(path.join(base, 'a.jsonl'), path.join(base, 'b.jsonl'))).toBe(false);
    expect(
      samePiSessionPath(path.join(base, 'a.jsonl'), path.join(base, 'nested', 'a.jsonl'))
    ).toBe(false);
  });

  it('resolves a relative path against the current directory, as the runtime does', () => {
    expect(samePiSessionPath('session.jsonl', path.resolve('session.jsonl'))).toBe(true);
    expect(samePiSessionPath('session.jsonl', path.resolve('other', 'session.jsonl'))).toBe(false);
  });

  it('follows the platform on case, which is the whole reason it is not ===', () => {
    const upper = path.resolve('/Repo/A.jsonl');
    const lower = path.resolve('/repo/a.jsonl');
    expect(samePiSessionPath(upper, lower)).toBe(process.platform === 'win32');
  });
});

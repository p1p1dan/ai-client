import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertLocalPathWritable,
  registerAllowedLocalFileRoot,
  unregisterAllowedLocalFileRootsByOwner,
} from '../LocalFileAccess';

const OWNER = 'test-owner';
const ROOT = path.resolve('/tmp/aiclient-guard-root');

/**
 * The write primitives on `file:*` used to take whatever absolute path the
 * renderer handed them. Each one was therefore a whole-disk primitive reachable
 * from renderer code — `file:delete` defaults to `recursive: true` — and
 * `file:copy` was once the second half of a real exploit (overwrite a file
 * inside an authorised attachment path to turn a read grant into a read of
 * something else; that route is closed by the fd-snapshot check, but the
 * primitive it used was never narrowed).
 */
describe('assertLocalPathWritable', () => {
  beforeEach(() => {
    unregisterAllowedLocalFileRootsByOwner(OWNER);
  });

  it('refuses everything while no root is registered', () => {
    expect(() => assertLocalPathWritable(path.join(ROOT, 'a.txt'), 'file:copy')).toThrow(
      /outside every opened repository/
    );
  });

  it('allows a path inside a registered root, and the root itself', () => {
    registerAllowedLocalFileRoot(ROOT, OWNER);
    expect(() => assertLocalPathWritable(ROOT, 'file:delete')).not.toThrow();
    expect(() =>
      assertLocalPathWritable(path.join(ROOT, 'deep', 'a.txt'), 'file:copy')
    ).not.toThrow();
  });

  /**
   * A sibling directory whose name merely STARTS WITH the root is the classic
   * prefix-match hole: `/repo` must not authorise `/repo-backup`.
   */
  it('refuses a sibling whose name only shares the root as a prefix', () => {
    registerAllowedLocalFileRoot(ROOT, OWNER);
    expect(() => assertLocalPathWritable(`${ROOT}-backup/a.txt`, 'file:move')).toThrow();
  });

  it('refuses a traversal that climbs back out', () => {
    registerAllowedLocalFileRoot(ROOT, OWNER);
    expect(() =>
      assertLocalPathWritable(path.join(ROOT, '..', '..', 'etc', 'passwd'), 'file:delete')
    ).toThrow(/outside every opened repository/);
  });

  /**
   * Throwing rather than returning false is the deliberate half: a refused write
   * has to be visible. A silently-skipped delete looks to the user exactly like
   * a delete that worked.
   */
  it('names the path and the operation, so a false positive is diagnosable', () => {
    registerAllowedLocalFileRoot(ROOT, OWNER);
    const stray = path.resolve('/tmp/somewhere-else/a.txt');
    expect(() => assertLocalPathWritable(stray, 'file:batchMove')).toThrow(
      new RegExp(`file:batchMove.*${stray.replace(/[/\\\\]/g, '.')}`)
    );
  });

  it('stops allowing a root once its owner goes away', () => {
    registerAllowedLocalFileRoot(ROOT, OWNER);
    unregisterAllowedLocalFileRootsByOwner(OWNER);
    expect(() => assertLocalPathWritable(path.join(ROOT, 'a.txt'), 'file:copy')).toThrow();
  });
});

/**
 * Coverage, asserted structurally: gating five of seven channels leaves the
 * hole open, and "did we remember all of them" is not something a behaviour
 * test over one handler can answer.
 */
describe('every local write primitive is gated', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../ipc/files.ts', import.meta.url)),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  const CHANNELS = [
    'file:createDir',
    'file:rename',
    'file:move',
    'file:delete',
    'file:copy',
    'file:batchCopy',
    'file:batchMove',
  ];

  it.each(CHANNELS)('%s asserts before it writes', (channel) => {
    expect(source).toContain(`assertLocalPathWritable(`);
    expect(source, `${channel} has no guard`).toContain(`'${channel}'`);
  });

  /**
   * The two-path channels need BOTH ends. Guarding only the source would let a
   * rename walk a repo file out to any path on the disk; guarding only the
   * target would let one pull any file in.
   */
  it.each(['file:rename', 'file:move', 'file:copy'])('%s guards both endpoints', (channel) => {
    const uses = source
      .split(`assertLocalPathWritable(`)
      .filter(
        (part) =>
          part.startsWith('fromPath') ||
          part.startsWith('toPath') ||
          part.startsWith('sourcePath') ||
          part.startsWith('targetPath')
      );
    expect(
      uses.length,
      'each two-path channel contributes two guarded endpoints'
    ).toBeGreaterThanOrEqual(6);
    expect(source.split(`'${channel}'`).length - 1, `${channel} guards two paths`).toBe(2);
  });

  /**
   * The batch channels guard before the loop. Inside it, an entry that fails the
   * check would land in `failed[]` alongside ordinary IO errors and the rest of
   * the batch would still apply — a half-written batch is worse than a refused
   * one.
   */
  it.each(['file:batchCopy', 'file:batchMove'])('%s refuses the whole batch', (channel) => {
    // TWO guards, not one: the shared target directory AND every source. A
    // target-only guard still lets any file on the disk be pulled INTO the
    // repo, which is the half that the first version of this test missed.
    const guards = [...source.matchAll(new RegExp(`'${channel}'`, 'g'))].map((m) => m.index ?? -1);
    expect(guards, `${channel} guards the target and the sources`).toHaveLength(2);

    const loopIndex = source.indexOf('for (const sourcePath of sources) {', guards[0]);
    expect(loopIndex, 'the per-entry loop exists').toBeGreaterThan(-1);
    for (const guard of guards) {
      expect(guard, 'every guard runs before the loop, not inside it').toBeLessThan(loopIndex);
    }
  });
});

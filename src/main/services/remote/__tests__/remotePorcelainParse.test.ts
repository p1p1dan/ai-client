import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  PorcelainV2FileChangesAccumulator,
  parsePorcelainV2Status,
} from '../../git/porcelainV2Status';
import { getRemoteServerSource } from '../RemoteServerSource';

/**
 * The remote helper is a standalone script (a source string run by the remote
 * host's node), so it cannot import `git/porcelainV2Status.ts`; it carries its
 * own copy of the porcelain v2 rules. These tests evaluate that copy and hold
 * it to the local parser: whole paths (spaces kept, never "the last word") and
 * renames recorded under the NEW path with the old one as `originalPath`.
 */

const HELPERS = [
  'porcelainPathAfterFields',
  'porcelainPathFieldCount',
  'porcelainRecords',
  'porcelainIndexStatus',
  'parsePorcelainStatus',
  'parseFileChanges',
];

type RemoteParsers = {
  parsePorcelainStatus: (stdout: string) => {
    current: string | null;
    tracking: string | null;
    ahead: number;
    behind: number;
    staged: string[];
    modified: string[];
    deleted: string[];
    untracked: string[];
    conflicted: string[];
    isClean: boolean;
  };
  parseFileChanges: (stdout: string) => { changes: unknown[] };
};

/** A top-level `function <name>(...) { ... }` of the helper source, verbatim. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  expect(start, `function ${name} in the remote helper`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

function loadRemoteParsers(): RemoteParsers {
  const source = getRemoteServerSource();
  const body = HELPERS.map((name) => extractFunction(source, name)).join('\n');
  return new Function(`${body}\nreturn { parsePorcelainStatus, parseFileChanges };`)();
}

const z = (records: string[]): string => records.map((record) => `${record}\0`).join('');
const OID = '6a69f92020f5df77af6e8813ff1232493383b708';

const RECORDS = [
  '# branch.oid a137f7993853cd1a8c6b3f454fd4ce3d0e0ab671',
  '# branch.head feature/x y',
  '# branch.upstream origin/feature/x y',
  '# branch.ab +2 -1',
  `1 .M N... 100644 100644 100644 ${OID} ${OID} with space.txt`,
  `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new name.txt`,
  'old name.txt',
  `1 M. N... 100644 100644 100644 ${OID} ${OID} 中文 文件.md`,
  `1 .D N... 100644 100644 000000 ${OID} ${OID} gone file.txt`,
  `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} both changed.txt`,
  '? untracked 新.txt',
  '! ignored.log',
];

describe('remote helper porcelain v2 parsing', () => {
  const remote = loadRemoteParsers();

  it('lists file changes exactly like the local parser', () => {
    const stdout = z(RECORDS);
    const local = new PorcelainV2FileChangesAccumulator(5000);
    for (const record of RECORDS) local.push(record);

    expect(remote.parseFileChanges(stdout).changes).toEqual(local.result().changes);
    expect(remote.parseFileChanges(stdout).changes).toEqual([
      { path: 'with space.txt', status: 'M', staged: false },
      { path: 'new name.txt', status: 'R', staged: true, originalPath: 'old name.txt' },
      { path: '中文 文件.md', status: 'M', staged: true },
      { path: 'gone file.txt', status: 'D', staged: false },
      { path: 'both changed.txt', status: 'X', staged: true },
      { path: 'both changed.txt', status: 'X', staged: false },
      { path: 'untracked 新.txt', status: 'U', staged: false },
    ]);
  });

  it('reads a status with whole paths and renames under the new path, like the local parser', () => {
    const stdout = z(RECORDS);
    const { status: local } = parsePorcelainV2Status(stdout, 5000);
    const status = remote.parsePorcelainStatus(stdout);

    expect(status).toMatchObject({
      current: local.current,
      tracking: local.tracking,
      ahead: local.ahead,
      behind: local.behind,
      staged: local.staged,
      modified: local.modified,
      deleted: local.deleted,
      untracked: local.untracked,
      conflicted: local.conflicted,
      isClean: false,
    });
    expect(status.staged).toEqual(['new name.txt', '中文 文件.md']);
    expect(status.current).toBe('feature/x y');
  });

  it('keeps an original path that looks like a header, and ignores an unterminated fragment', () => {
    const stdout = `${z([
      '# branch.head main',
      `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 b.txt`,
      '# not a header.txt',
    ])}1 .M N... trailing`;

    expect(remote.parseFileChanges(stdout).changes).toEqual([
      { path: 'b.txt', status: 'R', staged: true, originalPath: '# not a header.txt' },
    ]);
    expect(remote.parsePorcelainStatus(stdout)).toMatchObject({ staged: ['b.txt'], modified: [] });
  });

  it('still compiles as the script the remote host runs', () => {
    const source = getRemoteServerSource().replace(/^#!.*\r?\n/, '');
    expect(() => new Script(source, { filename: 'aiclient-remote-server.cjs' })).not.toThrow();
  });

  it('reports a clean tree as clean', () => {
    const stdout = z(['# branch.oid abc', '# branch.head main']);
    expect(remote.parseFileChanges(stdout).changes).toEqual([]);
    expect(remote.parsePorcelainStatus(stdout)).toMatchObject({ isClean: true, current: 'main' });
  });
});

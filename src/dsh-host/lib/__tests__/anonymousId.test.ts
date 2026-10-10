import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ID_FILE,
  type AnonymousIdFs,
  dshHomeFrom,
  readOrCreateAnonymousId,
} from '../anonymousId.ts';

/**
 * Decision 173 (GitHub issue #9), D: the host reads DSH's anonymous install
 * id the way `@deepseek-ai/dsh-anonymous-user-id` does, from the same file in
 * the same home, without depending on that package. The last group checks the
 * two against each other on one home.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWN = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiclient-anonymous-id-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fileOf = (dir: string) => join(dir, ANONYMOUS_ID_FILE);

/** The real file system, with `writeFileSync` replaced. */
function fsWith(write: AnonymousIdFs['writeFileSync']): AnonymousIdFs {
  return {
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    mkdirSync: (path, options) => mkdirSync(path, options),
    writeFileSync: write,
  };
}

describe('readOrCreateAnonymousId', () => {
  it('creates the file with a random UUID and a line feed, readable by its owner only', () => {
    const id = readOrCreateAnonymousId(home);
    expect(id).toMatch(UUID);
    expect(readFileSync(fileOf(home), 'utf8')).toBe(`${id}\n`);
    if (process.platform !== 'win32') expect(statSync(fileOf(home)).mode & 0o777).toBe(0o600);
    // Read back, not made again.
    expect(readOrCreateAnonymousId(home)).toBe(id);
    expect(readOrCreateAnonymousId(home, { randomUUID: () => OTHER })).toBe(id);
  });

  it('reads an id already there, trimmed, in its own letter case', () => {
    writeFileSync(fileOf(home), `  ${KNOWN.toUpperCase()}\r\n`);
    expect(readOrCreateAnonymousId(home, { randomUUID: () => OTHER })).toBe(KNOWN.toUpperCase());
    expect(readFileSync(fileOf(home), 'utf8')).toBe(`  ${KNOWN.toUpperCase()}\r\n`);
  });

  it('creates the DSH home when it is missing', () => {
    const nested = join(home, 'state', 'dsh-home');
    expect(readOrCreateAnonymousId(nested, { randomUUID: () => KNOWN })).toBe(KNOWN);
    expect(readFileSync(fileOf(nested), 'utf8')).toBe(`${KNOWN}\n`);
  });

  it('takes the id another process wrote first, and never replaces it', () => {
    const writes: Array<string | undefined> = [];
    const racing = fsWith((path, data, options) => {
      writes.push(options.flag);
      // The other process wins between our read and our exclusive create.
      writeFileSync(path, `${KNOWN}\n`);
      writeFileSync(path, data, options);
    });
    expect(readOrCreateAnonymousId(home, { fs: racing, randomUUID: () => OTHER })).toBe(KNOWN);
    expect(writes).toEqual(['wx']);
    expect(readFileSync(fileOf(home), 'utf8')).toBe(`${KNOWN}\n`);
  });

  it('writes over a file that holds no UUID, as DSH does', () => {
    writeFileSync(fileOf(home), 'not an id\n');
    expect(readOrCreateAnonymousId(home, { randomUUID: () => KNOWN })).toBe(KNOWN);
    expect(readFileSync(fileOf(home), 'utf8')).toBe(`${KNOWN}\n`);
  });

  it('still has an id when nothing can be written', () => {
    const readOnly = fsWith(() => {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    });
    expect(readOrCreateAnonymousId(home, { fs: readOnly, randomUUID: () => KNOWN })).toBe(KNOWN);
    expect(() => readFileSync(fileOf(home), 'utf8')).toThrow();
  });
});

describe('dshHomeFrom', () => {
  it.each([
    ['$DSH_HOME', { DSH_HOME: '/srv/state/dsh-home' }, resolve('/srv/state/dsh-home')],
    ['~/.dsh when unset', {}, join(homedir(), '.dsh')],
    ['~/.dsh when blank', { DSH_HOME: '  ' }, join(homedir(), '.dsh')],
    ['a leading ~/', { DSH_HOME: '~/state' }, join(homedir(), 'state')],
    ['a lone ~', { DSH_HOME: '~' }, homedir()],
    ['a relative path, made absolute', { DSH_HOME: 'state/dsh' }, resolve('state/dsh')],
  ])('finds %s', (_what, env: Record<string, string>, expected) => {
    expect(dshHomeFrom(env)).toBe(expected);
  });
});

describe("DSH's own package, on the same home", () => {
  it('finds the DSH home the same way', () => {
    for (const DSH_HOME of [undefined, '', ' ', '/srv/state/dsh-home', '~', '~/state', 'rel']) {
      const env = DSH_HOME === undefined ? {} : { DSH_HOME };
      expect(dshHomeFrom(env), String(DSH_HOME)).toBe(resolveDshHome(undefined, env));
    }
  });

  it('reads the id the host made', () => {
    const ours = readOrCreateAnonymousId(home);
    expect(getOrCreateAnonymousUserId({ env: { DSH_HOME: home } })).toBe(ours);
  });

  it('makes an id the host reads', () => {
    const theirs = getOrCreateAnonymousUserId({ env: { DSH_HOME: home } });
    expect(readOrCreateAnonymousId(home, { randomUUID: () => OTHER })).toBe(theirs);
  });
});

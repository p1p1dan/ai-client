import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGrants, type PermissionGrant } from '../../../shared/permissions/grants.ts';
import {
  copyGrantSidecar,
  MAX_GRANTS_SIDECAR_BYTES,
  readGrantSidecar,
  writeGrantSidecar,
} from '../grantStore.ts';

/**
 * dsh-rebase P1-6c — the grant sidecar's file rules (decision 043): the 1.0.x
 * v2 encoding, written atomically, read fail-closed (anything unreadable is
 * no grants, logged, never a failed open), copied for a fork.
 */

const GRANTS: PermissionGrant[] = [
  { kind: 'path', tool: 'write', path: '/work/out.txt' },
  { kind: 'command', prefix: 'npm test', root: '/work' },
  { kind: 'value', tool: 'skill', value: 'librarian' },
];

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-grants-'));
  file = join(dir, 'aiclient-sessions', 'aiclient-s.dsh.grants.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeGrantSidecar', () => {
  it('writes the v2 set whole, owner-only, leaving no temp file', () => {
    expect(writeGrantSidecar(file, encodeGrants(GRANTS))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2, grants: GRANTS });
    expect(readdirSync(join(dir, 'aiclient-sessions'))).toEqual(['aiclient-s.dsh.grants.json']);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'aiclient-sessions')).mode & 0o777).toBe(0o700);
    }
  });

  it('replaces the previous set, the empty one included (what configure writes)', () => {
    writeGrantSidecar(file, encodeGrants(GRANTS));
    writeGrantSidecar(file, encodeGrants([]));
    expect(readGrantSidecar(file)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2, grants: [] });
  });

  it('never throws: a failed write is logged, and nothing half-written is left', () => {
    // A directory where the file would go: the rename cannot land.
    mkdirSync(file, { recursive: true });
    const log = vi.fn();
    expect(writeGrantSidecar(file, encodeGrants(GRANTS), log)).toBe(false);
    expect(log).toHaveBeenCalledWith('[dsh-bridge] grants not written', file, expect.any(Error));
    expect(readdirSync(join(dir, 'aiclient-sessions'))).toEqual(['aiclient-s.dsh.grants.json']);
  });
});

describe('readGrantSidecar (fail closed)', () => {
  it('reads back what was written', () => {
    writeGrantSidecar(file, encodeGrants(GRANTS));
    expect(readGrantSidecar(file)).toEqual(GRANTS);
  });

  it('reads no file as no grants, silently', () => {
    const log = vi.fn();
    expect(readGrantSidecar(file, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{"version":2,"grants":[', 'not JSON'],
    ['a version this build does not read', '{"version":1,"grants":[]}', 'not a grant set'],
    ['no grant list', '{"version":2}', 'not a grant set'],
    ['not an object', '[1,2]', 'not a grant set'],
  ])('reads %s as no grants and logs it', (_what, body, said) => {
    mkdirSync(join(dir, 'aiclient-sessions'), { recursive: true });
    writeFileSync(file, body);
    const log = vi.fn();
    expect(readGrantSidecar(file, log)).toEqual([]);
    expect(String(log.mock.calls[0]?.[0])).toContain(said);
  });

  it('skips a malformed record and keeps the rest (1.0.x decodeGrants)', () => {
    mkdirSync(join(dir, 'aiclient-sessions'), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ version: 2, grants: [{ kind: 'path', tool: 'write' }, GRANTS[1]] })
    );
    expect(readGrantSidecar(file)).toEqual([GRANTS[1]]);
  });

  it('does not read a file too large to be a grant set', () => {
    mkdirSync(join(dir, 'aiclient-sessions'), { recursive: true });
    writeFileSync(file, Buffer.alloc(MAX_GRANTS_SIDECAR_BYTES + 1, 0x20));
    const log = vi.fn();
    expect(readGrantSidecar(file, log)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] grants ignored: cannot read',
      file,
      expect.objectContaining({ message: expect.stringContaining('larger than') })
    );
  });

  it('reads an unreadable path as no grants and logs it', () => {
    mkdirSync(file, { recursive: true });
    const log = vi.fn();
    expect(readGrantSidecar(file, log)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] grants ignored: cannot read',
      file,
      expect.anything()
    );
  });
});

describe('copyGrantSidecar (a fork, decision 043)', () => {
  it('copies the file byte for byte, atomically', () => {
    mkdirSync(join(dir, 'aiclient-sessions'), { recursive: true });
    writeFileSync(file, '{"version":2,"grants":[]}');
    const child = join(dir, 'aiclient-sessions', 'aiclient-child.dsh.grants.json');
    expect(copyGrantSidecar(file, child)).toBe(true);
    expect(readFileSync(child, 'utf8')).toBe('{"version":2,"grants":[]}');
    expect(readdirSync(join(dir, 'aiclient-sessions')).sort()).toEqual([
      'aiclient-child.dsh.grants.json',
      'aiclient-s.dsh.grants.json',
    ]);
  });

  it('copies nothing when the source has no grants file', () => {
    const child = join(dir, 'aiclient-sessions', 'aiclient-child.dsh.grants.json');
    const log = vi.fn();
    expect(copyGrantSidecar(file, child, log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(() => statSync(child)).toThrow();
  });

  it('never throws: a copy that fails is logged', () => {
    mkdirSync(file, { recursive: true });
    const child = join(dir, 'aiclient-sessions', 'aiclient-child.dsh.grants.json');
    const log = vi.fn();
    expect(copyGrantSidecar(file, child, log)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] grants not copied',
      file,
      child,
      expect.anything()
    );
  });
});

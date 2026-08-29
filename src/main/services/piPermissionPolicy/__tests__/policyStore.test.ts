import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRawDocument, readScope, readScopes, writeScopeDocument } from '../policyStore';

/**
 * T08-c slice 2 — the scope files, against a real filesystem.
 *
 * Real temp directories rather than a mocked `fs`: every interesting case here
 * is a filesystem state (absent, unreadable, half-written), and a mock would be
 * asserting that the mock behaves the way the author assumed.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiclient-policy-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe('readScope', () => {
  it('reads a config file into the narrow shape', () => {
    const path = write('global.json', JSON.stringify({ permission: { write: 'ask' } }));
    expect(readScope({ id: 'global', path })).toEqual({
      id: 'global',
      path,
      present: true,
      config: { permission: { write: 'ask' } },
    });
  });

  /** A missing file is the normal state, not a failure to report. */
  it('reports an absent file as simply not present', () => {
    const scope = readScope({ id: 'global', path: join(root, 'nope.json') });
    expect(scope).toMatchObject({ present: false, config: {} });
    expect(scope.parseError).toBeUndefined();
  });

  it('reports a broken file and contributes nothing from it', () => {
    const path = write('broken.json', '{ "permission": { "write": "ask", } }');
    const scope = readScope({ id: 'global', path });
    expect(scope.present).toBe(true);
    expect(scope.parseError).toBeTruthy();
    expect(scope.config).toEqual({});
  });

  it('keeps the readable rules of a partly invalid file and lists the issues', () => {
    const path = write(
      'partial.json',
      JSON.stringify({ permission: { write: 'ask', bash: { 'ls *': 'maybe' } } })
    );
    const scope = readScope({ id: 'global', path });
    expect(scope.config.permission?.write).toBe('ask');
    expect(scope.issues).toHaveLength(1);
  });

  it('carries a withheld reason through so the panel can explain it', () => {
    const path = write('project.json', JSON.stringify({ permission: { write: 'allow' } }));
    const scope = readScope({ id: 'project', path, withheldReason: 'untrusted' });
    expect(scope.withheldReason).toBe('untrusted');
    // Still READ: "your repo ships a policy that is being ignored" needs content.
    expect(scope.config.permission?.write).toBe('allow');
  });

  it('reads several scopes in the order it was given them', () => {
    const scopes = readScopes([
      { id: 'bundled', path: write('a.json', '{}') },
      { id: 'global', path: write('b.json', '{}') },
    ]);
    expect(scopes.map((scope) => scope.id)).toEqual(['bundled', 'global']);
  });
});

describe('readRawDocument', () => {
  it('returns the document untouched, including keys this app does not model', () => {
    const path = write('raw.json', JSON.stringify({ forwardingTimeoutMs: 5000, $schema: 'x' }));
    expect(readRawDocument(path)).toEqual({ forwardingTimeoutMs: 5000, $schema: 'x' });
  });

  it('returns an empty document for a missing file', () => {
    expect(readRawDocument(join(root, 'nope.json'))).toEqual({});
  });

  /** The only route back from a broken hand edit that does not need a text editor. */
  it('returns an empty document for a broken file, so a patch replaces it', () => {
    expect(readRawDocument(write('broken.json', 'not json'))).toEqual({});
  });

  it('returns an empty document for valid JSON that is not an object', () => {
    expect(readRawDocument(write('array.json', '[1,2]'))).toEqual({});
  });
});

describe('writeScopeDocument', () => {
  it('creates the directory chain on the way to a new file', () => {
    const path = join(root, 'agent', 'extensions', 'pi-permission-system', 'config.json');
    writeScopeDocument(path, { permission: { write: 'deny' } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permission: { write: 'deny' } });
  });

  it('writes indented JSON with a trailing newline', () => {
    const path = join(root, 'config.json');
    writeScopeDocument(path, { permission: { write: 'deny' } });
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "permission"');
  });

  /**
   * An empty file is not the same as no file on screen: it makes the panel
   * report a scope that says nothing, and makes "reset" leave a trace that
   * reads like a setting.
   */
  it('deletes the file rather than writing an empty document', () => {
    const path = write('config.json', JSON.stringify({ permission: { write: 'deny' } }));
    writeScopeDocument(path, {});
    expect(existsSync(path)).toBe(false);
  });

  it('does nothing when asked to write an empty document that has no file', () => {
    const path = join(root, 'absent', 'config.json');
    writeScopeDocument(path, {});
    expect(existsSync(path)).toBe(false);
    // And it did not create the directory on the way to not writing.
    expect(existsSync(join(root, 'absent'))).toBe(false);
  });

  it('treats a document with nothing but $schema as empty', () => {
    const path = write('config.json', '{}');
    writeScopeDocument(path, { $schema: 'x' });
    expect(existsSync(path)).toBe(false);
  });
});

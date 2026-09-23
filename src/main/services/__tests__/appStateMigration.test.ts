import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppStateMigrationInput,
  LOCAL_STORAGE_DIR_NAME,
  MIGRATION_MARKER_FILE_NAME,
  migrateAppState,
  migratePriorUserData,
  PRIOR_USER_DATA_MARKER_FILE_NAME,
  type PriorInstallSource,
  type PriorUserDataMigrationInput,
  rewriteRuntimeIdentity,
  SESSION_INDEX_FILE_NAME,
} from '../appStateMigration';

/**
 * Plan `unified-credentials` S2. The acceptance line this slice was given is
 * "an existing user must never be asked to log in again", and the vault is
 * what decides that — so the vault cases come first and are the strictest.
 */
describe('app state migration', () => {
  let root: string;
  let input: AppStateMigrationInput;

  function write(file: string, body: string, mode?: number): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'appstate-'));
    input = {
      legacyRoot: path.join(root, 'home', '.aiclient'),
      legacyCredentialsDir: path.join(root, 'userData', 'credentials'),
      newRoot: path.join(root, 'home', '.pilab', 'jyw-ai-client'),
      newCredentialsDir: path.join(root, 'home', '.pilab', 'jyw-ai-client', 'credentials'),
    };
  });

  it('carries the vault across, which is what keeps the user logged in', () => {
    write(path.join(input.legacyCredentialsDir, 'vault.json'), '{"version":1}');

    const outcome = migrateAppState(input);

    expect(outcome.kind).toBe('migrated');
    expect(readFileSync(path.join(input.newCredentialsDir, 'vault.json'), 'utf-8')).toBe(
      '{"version":1}'
    );
  });

  /**
   * The vault is 0600 at the source. A migration that recreated it with
   * `writeFileSync` would land it at the process umask — 0644 on a default
   * Linux box, i.e. a credential file every account on the machine can read.
   * `copyFileSync` carries the bits across, and this is what pins that choice.
   */
  it('keeps the vault file mode rather than inheriting a fresh umask', () => {
    write(path.join(input.legacyCredentialsDir, 'vault.json'), '{}', 0o600);

    migrateAppState(input);

    const mode = statSync(path.join(input.newCredentialsDir, 'vault.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('moves settings, session state and the remote sub-trees', () => {
    write(path.join(input.legacyRoot, 'settings.json'), '{"onboarding":{"registered":true}}');
    write(path.join(input.legacyRoot, 'session-state.json'), '{"version":2}');
    write(path.join(input.legacyRoot, '.local-settings-migrated'), 'done');
    write(path.join(input.legacyRoot, 'remote-auth', 'askpass.js'), '// askpass');
    write(path.join(input.legacyRoot, 'remote-known_hosts'), 'host key');

    const outcome = migrateAppState(input);

    expect(outcome.kind).toBe('migrated');
    for (const rel of [
      'settings.json',
      'session-state.json',
      '.local-settings-migrated',
      path.join('remote-auth', 'askpass.js'),
      'remote-known_hosts',
    ]) {
      expect(existsSync(path.join(input.newRoot, rel))).toBe(true);
    }
  });

  /**
   * The legacy root has no profile layer, so the release build and the dev
   * build migrate from the SAME `~/.aiclient`. A move would let whichever
   * booted first take the bytes and leave the other looking brand new.
   */
  it('leaves the source intact so a second profile can migrate from it too', () => {
    write(path.join(input.legacyRoot, 'settings.json'), '{"a":1}');
    write(path.join(input.legacyCredentialsDir, 'vault.json'), '{"v":1}');

    migrateAppState(input);
    expect(existsSync(path.join(input.legacyRoot, 'settings.json'))).toBe(true);

    const devRoot = path.join(root, 'home', '.pilab', 'jyw-ai-client-dev');
    const second = migrateAppState({
      ...input,
      legacyCredentialsDir: path.join(root, 'userData-dev', 'credentials'),
      newRoot: devRoot,
      newCredentialsDir: path.join(devRoot, 'credentials'),
    });

    expect(second.kind).toBe('migrated');
    expect(readFileSync(path.join(devRoot, 'settings.json'), 'utf-8')).toBe('{"a":1}');
  });

  it('never overwrites a file the new build has already written', () => {
    write(path.join(input.legacyRoot, 'settings.json'), '{"stale":true}');
    write(path.join(input.newRoot, 'settings.json'), '{"current":true}');

    const outcome = migrateAppState(input);

    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe(
      '{"current":true}'
    );
    expect(outcome.kind === 'migrated' && outcome.skippedExisting).toContain('settings.json');
  });

  it('is idempotent: a second run does nothing', () => {
    write(path.join(input.legacyRoot, 'settings.json'), '{"a":1}');
    migrateAppState(input);

    write(path.join(input.legacyRoot, 'added-later.json'), '{"b":2}');
    const second = migrateAppState(input);

    expect(second).toEqual({ kind: 'skipped', reason: 'marker_present' });
    expect(existsSync(path.join(input.newRoot, 'added-later.json'))).toBe(false);
  });

  it('writes the marker only once something was actually copied', () => {
    write(path.join(input.legacyRoot, 'settings.json'), '{"a":1}');
    migrateAppState(input);
    expect(existsSync(path.join(input.newRoot, MIGRATION_MARKER_FILE_NAME))).toBe(true);
  });

  /**
   * A fresh install must NOT be marked done: a user who restores
   * `~/.aiclient` from a backup tomorrow still has to be picked up.
   */
  it('leaves a fresh install unmarked so a later restore is still migrated', () => {
    expect(migrateAppState(input)).toEqual({ kind: 'skipped', reason: 'nothing_to_migrate' });
    expect(existsSync(path.join(input.newRoot, MIGRATION_MARKER_FILE_NAME))).toBe(false);

    write(path.join(input.legacyRoot, 'settings.json'), '{"restored":true}');
    expect(migrateAppState(input).kind).toBe('migrated');
    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe(
      '{"restored":true}'
    );
  });

  /** A machine that cannot be migrated still has to boot, and has to try again next time. */
  it('reports a failure without throwing, and without marking itself done', () => {
    write(path.join(input.legacyRoot, 'settings.json'), '{"a":1}');
    // A FILE where the new root's directory needs to be: every mkdir under it fails.
    write(input.newRoot, 'not a directory');

    const outcome = migrateAppState(input);

    expect(outcome.kind).toBe('failed');
    expect(existsSync(path.join(input.newRoot, MIGRATION_MARKER_FILE_NAME))).toBe(false);
  });
});

/**
 * The product rename, 1.0.0-test.17: `productName` went `AiClient` ->
 * `PiLab Ai` and `<userData>` was pinned to `PiLabAi`.
 *
 * `<profile>` is `<userData>`'s basename, so that rename moved the ENTIRE state
 * root — vault included. Without this source a tester upgrading from test.16
 * boots into an empty root and is asked to log in again, which is the one
 * outcome this module exists to prevent.
 */
describe('app state migration across a product rename', () => {
  let root: string;
  let input: AppStateMigrationInput;
  let prior: PriorInstallSource;

  function write(file: string, body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf-8');
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'appstate-rename-'));
    const newRoot = path.join(root, 'home', '.pilab', 'PiLabAi');
    prior = {
      root: path.join(root, 'home', '.pilab', 'AiClient'),
      credentialsDir: path.join(root, 'appData', 'AiClient', 'credentials'),
    };
    input = {
      legacyRoot: path.join(root, 'home', '.aiclient'),
      legacyCredentialsDir: path.join(root, 'appData', 'PiLabAi', 'credentials'),
      newRoot,
      newCredentialsDir: path.join(newRoot, 'credentials'),
      priorInstalls: [prior],
    };
  });

  it('carries the old product name’s vault and session history across', () => {
    write(path.join(prior.root, 'credentials', 'vault.json'), '{"version":1}');
    write(path.join(prior.root, 'settings.json'), '{"theme":"dark"}');
    write(path.join(prior.root, 'sessions', 'a.json'), '{"id":"a"}');

    const outcome = migrateAppState(input);

    expect(outcome.kind).toBe('migrated');
    expect(readFileSync(path.join(input.newCredentialsDir, 'vault.json'), 'utf-8')).toBe(
      '{"version":1}'
    );
    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe(
      '{"theme":"dark"}'
    );
    expect(readFileSync(path.join(input.newRoot, 'sessions', 'a.json'), 'utf-8')).toBe(
      '{"id":"a"}'
    );
  });

  /** An install that never reached S2 still has its vault under the old `<userData>`. */
  it('picks up the pre-S2 vault left under the old product’s userData', () => {
    write(path.join(prior.credentialsDir, 'vault.json'), '{"version":2}');

    const outcome = migrateAppState(input);

    expect(outcome.kind).toBe('migrated');
    expect(readFileSync(path.join(input.newCredentialsDir, 'vault.json'), 'utf-8')).toBe(
      '{"version":2}'
    );
  });

  /**
   * Both sources can hold the same file. The renamed install is already in the
   * S2 layout and is therefore the newer writer, so "first writer wins" has to
   * resolve to it rather than to the much older `~/.aiclient`.
   */
  it('prefers the renamed install over the older ~/.aiclient root', () => {
    write(path.join(prior.root, 'settings.json'), '{"from":"prior"}');
    write(path.join(input.legacyRoot, 'settings.json'), '{"from":"legacy"}');

    migrateAppState(input);

    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe(
      '{"from":"prior"}'
    );
  });

  it('leaves a machine that never ran the old build unmarked', () => {
    expect(migrateAppState(input)).toEqual({ kind: 'skipped', reason: 'nothing_to_migrate' });
    expect(existsSync(path.join(input.newRoot, MIGRATION_MARKER_FILE_NAME))).toBe(false);
  });

  /**
   * Guards a future release that points `<userData>` back at a name already in
   * `PRIOR_USER_DATA_DIR_NAMES`: the app would otherwise read its own root as a
   * migration source and report a migration it did not perform.
   */
  it('never treats the destination itself as a prior install', () => {
    write(path.join(input.newRoot, 'settings.json'), '{"current":true}');

    const outcome = migrateAppState({
      ...input,
      priorInstalls: [{ root: input.newRoot, credentialsDir: prior.credentialsDir }],
    });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'nothing_to_migrate' });
  });
});

/**
 * `rewriteRuntimeIdentity` is pure string work on paths a WINDOWS build wrote,
 * so these cases are built with `path.win32` explicitly — on a Linux runner the
 * host `path` would never produce a backslash and the Windows arm would go
 * untested (the lesson behind `[PRIOR-1..4]`).
 */
describe('runtimeIdentity rewrite (Windows paths)', () => {
  const win = path.win32;
  const home = win.join('C:', 'Users', 'Bob');
  const options = (existing: string[]) => ({
    priorProfileNames: ['AiClient', 'jyw-ai-client'],
    newProfileName: 'PiLabAi',
    exists: (candidate: string) => existing.includes(candidate),
  });

  it('moves .pilab\\<former name>\\ onto the new profile when the new file exists', () => {
    const old = win.join(home, '.pilab', 'jyw-ai-client', 'pi-agent', 'sessions', 's1.jsonl');
    const expected = win.join(home, '.pilab', 'PiLabAi', 'pi-agent', 'sessions', 's1.jsonl');
    expect(rewriteRuntimeIdentity(old, options([expected]))).toEqual({
      identity: expected,
      outcome: 'rewritten',
    });
  });

  it('matches the profile segment case-insensitively and keeps the rest verbatim', () => {
    const old = 'c:\\USERS\\Bob\\.PILAB\\JYW-AI-CLIENT\\pi-agent\\sessions\\S1.jsonl';
    const expected = 'c:\\USERS\\Bob\\.pilab\\PiLabAi\\pi-agent\\sessions\\S1.jsonl';
    expect(rewriteRuntimeIdentity(old, options([expected])).identity).toBe(expected);
  });

  it('accepts forward and mixed separators', () => {
    const forward = 'C:/Users/Bob/.pilab/AiClient/pi-agent/sessions/s.jsonl';
    expect(
      rewriteRuntimeIdentity(
        forward,
        options(['C:/Users/Bob/.pilab/PiLabAi/pi-agent/sessions/s.jsonl'])
      ).outcome
    ).toBe('rewritten');

    const mixed = 'C:\\Users\\Bob/.pilab\\jyw-ai-client/pi-agent\\s.jsonl';
    const expected = 'C:\\Users\\Bob/.pilab/PiLabAi/pi-agent\\s.jsonl';
    expect(rewriteRuntimeIdentity(mixed, options([expected])).identity).toBe(expected);
  });

  it('maps the older .aiclient\\ root onto the new profile too', () => {
    const old = win.join(home, '.aiclient', 'pi-agent', 'sessions', 's.jsonl');
    const expected = win.join(home, '.pilab', 'PiLabAi', 'pi-agent', 'sessions', 's.jsonl');
    expect(rewriteRuntimeIdentity(old, options([expected])).identity).toBe(expected);
  });

  it('keeps the old path, and says so, when the new .jsonl does not exist', () => {
    const old = win.join(home, '.pilab', 'jyw-ai-client', 'pi-agent', 'sessions', 'gone.jsonl');
    expect(rewriteRuntimeIdentity(old, options([]))).toEqual({
      identity: old,
      outcome: 'kept_missing',
    });
  });

  it('does not touch a dev profile that merely starts with a former name, or the new profile', () => {
    const dev = win.join(home, '.pilab', 'jyw-ai-client-dev', 'pi-agent', 's.jsonl');
    const current = win.join(home, '.pilab', 'PiLabAi', 'pi-agent', 's.jsonl');
    const everything = { ...options([]), exists: () => true };
    expect(rewriteRuntimeIdentity(dev, everything)).toEqual({
      identity: dev,
      outcome: 'unchanged',
    });
    expect(rewriteRuntimeIdentity(current, everything)).toEqual({
      identity: current,
      outcome: 'unchanged',
    });
  });
});

/**
 * The `<userData>` half: `Local Storage` (repository list) and
 * `session-index.json` (conversation list), which live under the OLD
 * `<appData>/<name>` and were never carried by `migrateAppState`.
 */
describe('prior userData migration', () => {
  let root: string;
  let home: string;
  let appData: string;
  let newRoot: string;
  let oldUserData: string;
  let input: PriorUserDataMigrationInput;

  function write(file: string, body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf-8');
  }

  /** A stand-in leveldb: the file names are the real ones, the bytes are a tag. */
  function writeLeveldb(userData: string, tag: string, files: string[]): void {
    for (const name of files) {
      write(path.join(userData, LOCAL_STORAGE_DIR_NAME, 'leveldb', name), `${tag}:${name}`);
    }
  }

  function leveldbFiles(userData: string): string[] {
    return readdirSync(path.join(userData, LOCAL_STORAGE_DIR_NAME, 'leveldb')).sort();
  }

  function readIndex(userData: string): Array<Record<string, unknown>> {
    return JSON.parse(readFileSync(path.join(userData, SESSION_INDEX_FILE_NAME), 'utf-8'));
  }

  function row(sessionId: string, runtimeIdentity: string | undefined, workspacePath: string) {
    return { sessionId, runtimeIdentity, workspacePath, title: sessionId, updatedAt: 1 };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'appstate-userdata-'));
    home = path.join(root, 'home');
    appData = path.join(root, 'appData');
    newRoot = path.join(home, '.pilab', 'PiLabAi');
    oldUserData = path.join(appData, 'jyw-ai-client');
    input = {
      userDataDir: path.join(appData, 'PiLabAi'),
      newRoot,
      priorUserDataDirs: [path.join(appData, 'AiClient'), oldUserData],
    };
  });

  /** Class A — v0.3.4: repositories in Local Storage, no session-index.json at all. */
  it('carries a v0.3.4 Local Storage across whole, leaving the source in place', () => {
    const files = ['000005.ldb', '000089.log', 'CURRENT', 'LOCK', 'LOG', 'MANIFEST-000001'];
    writeLeveldb(oldUserData, 'old', files);
    write(path.join(home, '.aiclient', 'settings.json'), '{}');

    const outcome = migratePriorUserData(input);

    expect(outcome).toMatchObject({ kind: 'migrated', localStorage: 'copied' });
    expect(leveldbFiles(input.userDataDir)).toEqual([...files].sort());
    expect(
      readFileSync(
        path.join(input.userDataDir, LOCAL_STORAGE_DIR_NAME, 'leveldb', 'MANIFEST-000001'),
        'utf-8'
      )
    ).toBe('old:MANIFEST-000001');
    expect(leveldbFiles(oldUserData)).toEqual([...files].sort());
    expect(existsSync(path.join(input.userDataDir, `${LOCAL_STORAGE_DIR_NAME}.migrating`))).toBe(
      false
    );
    expect(existsSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME))).toBe(false);
    expect(existsSync(path.join(input.userDataDir, PRIOR_USER_DATA_MARKER_FILE_NAME))).toBe(true);
  });

  /**
   * leveldb is one store spread over files. Mixing an old MANIFEST/CURRENT
   * into a new store is worse than no copy, so an existing destination is kept
   * WHOLE — not a single old file may land in it.
   */
  it('keeps an existing Local Storage whole rather than mixing old files into it', () => {
    writeLeveldb(oldUserData, 'old', ['000005.ldb', '000089.log', 'CURRENT', 'MANIFEST-000001']);
    writeLeveldb(input.userDataDir, 'new', ['000003.log', 'CURRENT', 'MANIFEST-000001']);

    const outcome = migratePriorUserData(input);

    expect(outcome).toMatchObject({ kind: 'migrated', localStorage: 'kept_existing' });
    expect(leveldbFiles(input.userDataDir)).toEqual(['000003.log', 'CURRENT', 'MANIFEST-000001']);
    expect(
      readFileSync(
        path.join(input.userDataDir, LOCAL_STORAGE_DIR_NAME, 'leveldb', 'CURRENT'),
        'utf-8'
      )
    ).toBe('new:CURRENT');
  });

  it('discards its own half-copied staging directory from an interrupted attempt', () => {
    writeLeveldb(oldUserData, 'old', ['CURRENT', 'MANIFEST-000001']);
    write(
      path.join(input.userDataDir, `${LOCAL_STORAGE_DIR_NAME}.migrating`, 'leveldb', 'STALE'),
      'half'
    );

    migratePriorUserData(input);

    expect(leveldbFiles(input.userDataDir)).toEqual(['CURRENT', 'MANIFEST-000001']);
  });

  /**
   * Class B — test.16: `~/.pilab/jyw-ai-client` holds the .jsonl files and
   * `<appData>/jyw-ai-client/session-index.json` points at them. Runs the real
   * boot order: `migrateAppState` first, so the .jsonl already sits in the new
   * root when the identity is checked.
   */
  it('carries a test.16 conversation list across and re-points it at the new root', () => {
    const oldRoot = path.join(home, '.pilab', 'jyw-ai-client');
    const oldJsonl = path.join(oldRoot, 'pi-agent', 'sessions', 's1.jsonl');
    write(oldJsonl, '{"type":"session"}\n');
    const workspace = path.join(root, 'repos', 'jyw-ai-client', 'project');
    write(
      path.join(oldUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([
        row('s1', oldJsonl, workspace),
        row('s2', undefined, workspace),
        { title: 'no id' },
      ])
    );
    writeLeveldb(oldUserData, 'old', ['CURRENT']);

    migrateAppState({
      legacyRoot: path.join(home, '.aiclient'),
      legacyCredentialsDir: path.join(input.userDataDir, 'credentials'),
      newRoot,
      newCredentialsDir: path.join(newRoot, 'credentials'),
      priorInstalls: [{ root: oldRoot, credentialsDir: path.join(oldUserData, 'credentials') }],
    });
    const outcome = migratePriorUserData(input);

    expect(outcome).toMatchObject({
      kind: 'migrated',
      localStorage: 'copied',
      sessionIndex: { added: 2, keptExisting: 0, identityRewritten: 1, identityKept: 0 },
    });
    const rows = readIndex(input.userDataDir);
    expect(rows.map((r) => r.sessionId)).toEqual(['s1', 's2']);
    expect(rows[0]?.runtimeIdentity).toBe(path.join(newRoot, 'pi-agent', 'sessions', 's1.jsonl'));
    expect(existsSync(rows[0]?.runtimeIdentity as string)).toBe(true);
    // workspacePath names the user's repository — even one whose own path
    // happens to contain a former profile name is not ours to rewrite.
    expect(rows.map((r) => r.workspacePath)).toEqual([workspace, workspace]);
    expect(rows[1]).not.toHaveProperty('runtimeIdentity');
    // Source untouched: the old build can still be rolled back to.
    expect(readFileSync(path.join(oldUserData, SESSION_INDEX_FILE_NAME), 'utf-8')).toContain(
      oldJsonl.replace(/\\/g, '\\\\')
    );
  });

  it('leaves an identity on its old path when the new .jsonl is not there', () => {
    const oldJsonl = path.join(home, '.pilab', 'jyw-ai-client', 'pi-agent', 'sessions', 'x.jsonl');
    write(
      path.join(oldUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([row('x', oldJsonl, '/repo')])
    );

    const outcome = migratePriorUserData(input);

    expect(outcome).toMatchObject({ sessionIndex: { identityRewritten: 0, identityKept: 1 } });
    expect(readIndex(input.userDataDir)[0]?.runtimeIdentity).toBe(oldJsonl);
  });

  /**
   * Class B, already booted on test.17+: `.migrated-from-aiclient` is present
   * and the new build has written its own index. The old marker must not stop
   * this step, and rows the new build owns must win.
   */
  it('still fills in a machine that already carries the old marker, merging by sessionId', () => {
    write(path.join(newRoot, MIGRATION_MARKER_FILE_NAME), 'done');
    write(path.join(newRoot, 'pi-agent', 'sessions', 'old-only.jsonl'), '{}');
    const oldJsonl = (id: string) =>
      path.join(home, '.pilab', 'jyw-ai-client', 'pi-agent', 'sessions', `${id}.jsonl`);
    write(
      path.join(oldUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([
        { ...row('shared', oldJsonl('shared'), '/repo'), title: 'old title' },
        row('old-only', oldJsonl('old-only'), '/repo'),
      ])
    );
    const newRow = { ...row('shared', 'NEW-IDENTITY', '/repo'), title: 'renamed in new build' };
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([row('new-only', 'N', '/repo'), newRow])
    );

    const outcome = migratePriorUserData(input);

    expect(outcome).toMatchObject({
      kind: 'migrated',
      sessionIndex: { added: 1, keptExisting: 1, identityRewritten: 1 },
    });
    const rows = readIndex(input.userDataDir);
    expect(rows.map((r) => r.sessionId)).toEqual(['new-only', 'shared', 'old-only']);
    expect(rows[1]).toEqual(newRow);
    expect(rows[2]?.runtimeIdentity).toBe(
      path.join(newRoot, 'pi-agent', 'sessions', 'old-only.jsonl')
    );
  });

  it('lets the newest prior name win when two carry the same sessionId', () => {
    write(
      path.join(appData, 'AiClient', SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ ...row('s', undefined, '/a'), title: 'newer' }])
    );
    write(
      path.join(oldUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ ...row('s', undefined, '/a'), title: 'older' }])
    );

    migratePriorUserData(input);

    expect(readIndex(input.userDataDir).map((r) => r.title)).toEqual(['newer']);
  });

  it('is idempotent: a re-run — marker or not — changes nothing', () => {
    const oldJsonl = path.join(home, '.pilab', 'jyw-ai-client', 'pi-agent', 'sessions', 'a.jsonl');
    write(path.join(newRoot, 'pi-agent', 'sessions', 'a.jsonl'), '{}');
    write(
      path.join(oldUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([row('a', oldJsonl, '/r'), row('b', undefined, '/r')])
    );
    writeLeveldb(oldUserData, 'old', ['CURRENT', 'MANIFEST-000001']);

    migratePriorUserData(input);
    const indexAfterFirst = readFileSync(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      'utf-8'
    );
    const filesAfterFirst = leveldbFiles(input.userDataDir);

    expect(migratePriorUserData(input)).toEqual({ kind: 'skipped', reason: 'marker_present' });

    // Without the marker the merge rules alone must still be a no-op.
    rmSync(path.join(input.userDataDir, PRIOR_USER_DATA_MARKER_FILE_NAME));
    expect(migratePriorUserData(input)).toMatchObject({
      kind: 'migrated',
      localStorage: 'kept_existing',
      sessionIndex: { added: 0, keptExisting: 2 },
    });
    expect(readFileSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'utf-8')).toBe(
      indexAfterFirst
    );
    expect(leveldbFiles(input.userDataDir)).toEqual(filesAfterFirst);
  });

  it('refuses to write over an index it cannot read, and retries next boot', () => {
    write(
      path.join(oldUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([row('a', undefined, '/r')])
    );
    write(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), '[{"sessionId":"trunc');

    const outcome = migratePriorUserData(input);

    expect(outcome.kind).toBe('failed');
    expect(readFileSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'utf-8')).toBe(
      '[{"sessionId":"trunc'
    );
    expect(existsSync(path.join(input.userDataDir, PRIOR_USER_DATA_MARKER_FILE_NAME))).toBe(false);
  });

  it('skips an unreadable old index instead of failing forever on it', () => {
    write(path.join(oldUserData, SESSION_INDEX_FILE_NAME), 'not json');
    writeLeveldb(oldUserData, 'old', ['CURRENT']);

    expect(migratePriorUserData(input)).toMatchObject({
      kind: 'migrated',
      localStorage: 'copied',
      sessionIndex: { added: 0, unreadableSources: 1 },
    });
  });

  it('leaves a machine with no prior userData unmarked', () => {
    expect(migratePriorUserData(input)).toEqual({ kind: 'skipped', reason: 'nothing_to_migrate' });
    expect(existsSync(path.join(input.userDataDir, PRIOR_USER_DATA_MARKER_FILE_NAME))).toBe(false);
  });

  it('never treats its own userData as a prior one', () => {
    writeLeveldb(input.userDataDir, 'new', ['CURRENT']);
    expect(migratePriorUserData({ ...input, priorUserDataDirs: [input.userDataDir] })).toEqual({
      kind: 'skipped',
      reason: 'nothing_to_migrate',
    });
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppStateMigrationInput,
  MIGRATION_MARKER_FILE_NAME,
  migrateAppState,
  type PriorInstallSource,
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

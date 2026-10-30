import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_STATE_DIR } from '@shared/defaultPaths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_ENV_RELOCATION_MARKER_FILE_NAME,
  type HomeEnvRelocationInput,
  MIGRATION_MARKER_FILE_NAME,
  relocateHomeEnvAppState,
  SESSION_INDEX_FILE_NAME,
} from '../appStateMigration';

/**
 * V1.2.1 field report (2026-10-30): Cadence SPB sets `HOME` to its own config
 * directory, and the app wrote its whole root in there on every start.
 */
describe('relocateHomeEnvAppState', () => {
  let sandbox: string;
  let cadenceHome: string;
  let input: HomeEnvRelocationInput;

  function write(file: string, body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf-8');
  }

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'home-env-relocation-'));
    cadenceHome = path.join(sandbox, 'SPB_Data');
    write(path.join(cadenceHome, 'allegro.jrl'), 'cadence');
    input = {
      // Built the way `buildAppStateRoot` builds it: `/` joins.
      strayRoot: [cadenceHome, APP_STATE_DIR, 'PiLabAi'].join('/'),
      newRoot: path.join(sandbox, 'profile', APP_STATE_DIR, 'PiLabAi'),
      userDataDir: path.join(sandbox, 'appData', 'PiLabAi'),
    };
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('does nothing when HOME holds no root', () => {
    expect(relocateHomeEnvAppState(input)).toEqual({ kind: 'skipped', reason: 'no_stray_root' });
    expect(existsSync(input.newRoot)).toBe(false);
  });

  it('moves the root, re-points the conversation list and leaves HOME as Cadence had it', () => {
    const strayFile = path.join(input.strayRoot, 'dsh-home', 'aiclient-sessions', 'a.dsh.json');
    write(path.join(input.strayRoot, 'credentials', 'vault.json'), '{"v":1}');
    write(path.join(input.strayRoot, MIGRATION_MARKER_FILE_NAME), 'done');
    write(strayFile, '{}');
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([
        {
          sessionId: 's1',
          runtimeIdentity: strayFile,
          migratedFrom: { runtimeIdentity: path.join(input.strayRoot, 'pi-agent', 'x.jsonl') },
          workspacePath: '/work',
        },
      ])
    );

    expect(relocateHomeEnvAppState(input)).toEqual({
      kind: 'relocated',
      keptAside: null,
      indexPathsRewritten: 2,
      strayRemoved: true,
    });

    expect(readFileSync(path.join(input.newRoot, 'credentials', 'vault.json'), 'utf-8')).toBe(
      '{"v":1}'
    );
    expect(existsSync(path.join(input.newRoot, MIGRATION_MARKER_FILE_NAME))).toBe(true);
    expect(existsSync(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME))).toBe(true);
    const [row] = JSON.parse(
      readFileSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'utf-8')
    );
    expect(row.runtimeIdentity).toBe(
      path.join(input.newRoot, 'dsh-home', 'aiclient-sessions', 'a.dsh.json')
    );
    expect(row.migratedFrom.runtimeIdentity).toBe(path.join(input.newRoot, 'pi-agent', 'x.jsonl'));
    expect(row.workspacePath).toBe('/work');
    expect(existsSync(row.runtimeIdentity)).toBe(true);

    // The container goes too, and nothing of Cadence's is touched.
    expect(readdirSync(cadenceHome)).toEqual(['allegro.jrl']);
  });

  it('matches index paths case- and separator-insensitively, as a Windows build wrote them', () => {
    write(path.join(input.strayRoot, 'settings.json'), '{}');
    const windowsSpelled = `${input.strayRoot.toUpperCase().replaceAll('/', '\\')}\\pi-agent\\y.jsonl`;
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ sessionId: 's1', runtimeIdentity: windowsSpelled }])
    );

    expect(relocateHomeEnvAppState(input)).toMatchObject({
      kind: 'relocated',
      indexPathsRewritten: 1,
    });
    const [row] = JSON.parse(
      readFileSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'utf-8')
    );
    expect(row.runtimeIdentity.startsWith(input.newRoot)).toBe(true);
    expect(row.runtimeIdentity.endsWith('y.jsonl')).toBe(true);
  });

  it('never matches a sibling whose name only starts with the root', () => {
    write(path.join(input.strayRoot, 'settings.json'), '{}');
    const sibling = `${input.strayRoot}-dev/settings.json`;
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ sessionId: 's1', runtimeIdentity: sibling }])
    );

    expect(relocateHomeEnvAppState(input)).toMatchObject({ indexPathsRewritten: 0 });
  });

  it('merges an earlier root at the destination, stray wins, and keeps the old one aside', () => {
    write(path.join(input.strayRoot, 'settings.json'), 'stray');
    write(path.join(input.newRoot, 'settings.json'), 'old');
    write(path.join(input.newRoot, 'pi-agent', 'sessions', 'old.jsonl'), 'old-session');

    const outcome = relocateHomeEnvAppState(input);
    expect(outcome).toMatchObject({ kind: 'relocated', strayRemoved: true });
    if (outcome.kind !== 'relocated' || !outcome.keptAside)
      throw new Error('expected kept-aside root');

    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe('stray');
    expect(
      readFileSync(path.join(input.newRoot, 'pi-agent', 'sessions', 'old.jsonl'), 'utf-8')
    ).toBe('old-session');
    expect(readFileSync(path.join(outcome.keptAside, 'settings.json'), 'utf-8')).toBe('old');
  });

  it('keeps another profile in the HOME container', () => {
    write(path.join(input.strayRoot, 'settings.json'), '{}');
    write(path.join(cadenceHome, APP_STATE_DIR, 'PiLabAi-dev', 'settings.json'), '{}');

    relocateHomeEnvAppState(input);
    expect(readdirSync(path.join(cadenceHome, APP_STATE_DIR))).toEqual(['PiLabAi-dev']);
  });

  it('only deletes a leftover once the root has already been relocated', () => {
    write(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'done');
    write(path.join(input.newRoot, 'settings.json'), 'new');
    write(path.join(input.strayRoot, 'settings.json'), 'leftover');

    expect(relocateHomeEnvAppState(input)).toEqual({ kind: 'cleaned_up', strayRemoved: true });
    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe('new');
    expect(readdirSync(cadenceHome)).toEqual(['allegro.jrl']);
  });

  it('fails without moving anything when the conversation list cannot be read', () => {
    write(path.join(input.strayRoot, 'settings.json'), '{}');
    write(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'not json');

    expect(relocateHomeEnvAppState(input)).toMatchObject({ kind: 'failed' });
    expect(existsSync(path.join(input.strayRoot, 'settings.json'))).toBe(true);
    expect(existsSync(input.newRoot)).toBe(false);
  });
});

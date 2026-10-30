import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_STATE_DIR } from '@shared/defaultPaths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_ENV_RELOCATION_MARKER_FILE_NAME,
  type HomeEnvRelocationInput,
  MIGRATION_MARKER_FILE_NAME,
  relocateHomeEnvAppState,
  SESSION_INDEX_FILE_NAME,
} from '../appStateMigration';

const fsFault = vi.hoisted(() => ({ failStagingRename: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Windows answers EPERM when antivirus or the indexer holds a just-copied file.
    renameSync: (from: string, to: string) => {
      if (fsFault.failStagingRename && String(from).endsWith('.relocating')) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      actual.renameSync(from, to);
    },
  };
});

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
    fsFault.failStagingRename = false;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function readIndex(): Array<Record<string, unknown>> {
    return JSON.parse(readFileSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'utf-8'));
  }

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

  it('merges a leftover in without overwriting, then deletes it', () => {
    write(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'done');
    write(path.join(input.newRoot, 'settings.json'), 'new');
    write(path.join(input.strayRoot, 'settings.json'), 'leftover');

    expect(relocateHomeEnvAppState(input)).toEqual({
      kind: 'cleaned_up',
      indexPathsRewritten: 0,
      strayRemoved: true,
    });
    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe('new');
    expect(readdirSync(cadenceHome)).toEqual(['allegro.jrl']);
  });

  it('keeps a conversation an older build wrote into HOME after the move', () => {
    write(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'done');
    const written = path.join(input.strayRoot, 'dsh-home', 'aiclient-sessions', 'late.dsh.json');
    write(written, 'late');
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ sessionId: 'late', runtimeIdentity: written }])
    );

    expect(relocateHomeEnvAppState(input)).toMatchObject({
      kind: 'cleaned_up',
      indexPathsRewritten: 1,
    });
    const [row] = readIndex();
    expect(readFileSync(String(row.runtimeIdentity), 'utf-8')).toBe('late');
  });

  it('rewrites the index without dropping a row it does not understand', () => {
    write(path.join(input.strayRoot, 'settings.json'), '{}');
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ note: 'no id', file: `${input.strayRoot}/a` }, { sessionId: 's1' }])
    );

    expect(relocateHomeEnvAppState(input)).toMatchObject({ indexPathsRewritten: 1 });
    expect(readIndex()).toEqual([
      { note: 'no id', file: path.join(input.newRoot, 'a') },
      { sessionId: 's1' },
    ]);
  });

  it('on an unreadable index keeps HOME whole and unmarked, and the next boot finishes', () => {
    const session = path.join(input.strayRoot, 'pi-agent', 's.jsonl');
    write(path.join(input.strayRoot, 'settings.json'), 'stray');
    write(session, 'x');
    write(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'not json');

    expect(relocateHomeEnvAppState(input)).toMatchObject({ kind: 'failed' });
    expect(readFileSync(path.join(input.strayRoot, 'settings.json'), 'utf-8')).toBe('stray');
    expect(existsSync(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME))).toBe(false);

    // The run falls back to HOME and changes something there.
    write(path.join(input.strayRoot, 'settings.json'), 'changed-after-failure');
    // `SessionIndexService` set the corrupt file aside and wrote a fresh one.
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ sessionId: 's', runtimeIdentity: session }])
    );

    expect(relocateHomeEnvAppState(input)).toMatchObject({
      kind: 'relocated',
      indexPathsRewritten: 1,
      strayRemoved: true,
    });
    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe(
      'changed-after-failure'
    );
    expect(readFileSync(String(readIndex()[0].runtimeIdentity), 'utf-8')).toBe('x');
  });

  it('on a failed swap puts the earlier root back and leaves the index alone', () => {
    const strayFile = path.join(input.strayRoot, 'pi-agent', 's.jsonl');
    write(strayFile, 'x');
    write(path.join(input.newRoot, 'settings.json'), 'old');
    const index = JSON.stringify([{ sessionId: 's', runtimeIdentity: strayFile }]);
    write(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), index);
    fsFault.failStagingRename = true;

    expect(relocateHomeEnvAppState(input)).toMatchObject({ kind: 'failed' });
    expect(readdirSync(input.newRoot)).toEqual(['settings.json']);
    expect(readFileSync(path.join(input.newRoot, 'settings.json'), 'utf-8')).toBe('old');
    expect(readFileSync(strayFile, 'utf-8')).toBe('x');
    expect(readFileSync(path.join(input.userDataDir, SESSION_INDEX_FILE_NAME), 'utf-8')).toBe(
      index
    );
    expect(readdirSync(path.dirname(input.newRoot)).sort()).toEqual([
      'PiLabAi',
      'PiLabAi.relocating',
    ]);
  });

  it('on a failed first swap leaves no root behind', () => {
    write(path.join(input.strayRoot, 'settings.json'), 'stray');
    fsFault.failStagingRename = true;

    expect(relocateHomeEnvAppState(input)).toMatchObject({ kind: 'failed' });
    expect(existsSync(input.newRoot)).toBe(false);
    expect(readFileSync(path.join(input.strayRoot, 'settings.json'), 'utf-8')).toBe('stray');
  });

  describe('when HOME reaches the profile by another spelling (8.3 name, junction, subst)', () => {
    let aliasInput: HomeEnvRelocationInput;

    beforeEach(() => {
      const profile = path.join(sandbox, 'profile');
      const alias = path.join(sandbox, 'PROFIL~1');
      mkdirSync(profile, { recursive: true });
      symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
      aliasInput = { ...input, strayRoot: [alias, APP_STATE_DIR, 'PiLabAi'].join('/') };
      write(path.join(input.newRoot, 'credentials', 'vault.json'), '{"v":1}');
    });

    it('leaves the root alone', () => {
      expect(relocateHomeEnvAppState(aliasInput)).toEqual({
        kind: 'skipped',
        reason: 'same_directory',
      });
      expect(readFileSync(path.join(input.newRoot, 'credentials', 'vault.json'), 'utf-8')).toBe(
        '{"v":1}'
      );
    });

    it('never mistakes the root for a leftover, even after a relocation', () => {
      write(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'done');
      expect(relocateHomeEnvAppState(aliasInput)).toMatchObject({ reason: 'same_directory' });
      expect(existsSync(path.join(input.newRoot, 'credentials', 'vault.json'))).toBe(true);
    });
  });
});

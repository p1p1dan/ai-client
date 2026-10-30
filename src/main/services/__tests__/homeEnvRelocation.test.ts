import {
  chmodSync,
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
  migrateAppState,
  relocateHomeEnvAppState,
  SESSION_INDEX_FILE_NAME,
} from '../appStateMigration';

const fsFault = vi.hoisted(() => ({ failStagingRename: false, untrustedFileIndex: false }));

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
    // A filesystem whose file index cannot be trusted (some SMB, FAT, ReFS
    // setups): the identity check sees two different directories.
    statSync: ((target: string, options?: { bigint?: boolean }) => {
      if (fsFault.untrustedFileIndex && options?.bigint) {
        const stats = actual.statSync(target, options as { bigint: true });
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          ino: BigInt(Math.floor(Math.random() * 1e9) + 1),
        });
      }
      return actual.statSync(target, options as never);
    }) as typeof actual.statSync,
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
    fsFault.untrustedFileIndex = false;
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

  it('re-points the JSON files inside the root, keeping their layout', () => {
    const stub = path.join(input.strayRoot, 'dsh-home', 'aiclient-sessions', 'a.dsh.json');
    const jsonl = path.join(input.strayRoot, 'pi-agent', 'sessions', 'a.jsonl');
    write(jsonl, '{}');
    write(stub, JSON.stringify({ origin: { file: { path: jsonl } } }));
    const plugins = path.join(input.strayRoot, 'claude', 'plugins', 'installed_plugins.json');
    const installPath = path.join(input.strayRoot, 'claude', 'plugins', 'cache', 'p');
    write(plugins, `${JSON.stringify({ p: { installPath } }, null, 2)}\n`);

    relocateHomeEnvAppState(input);

    const movedStub = path.join(input.newRoot, 'dsh-home', 'aiclient-sessions', 'a.dsh.json');
    expect(JSON.parse(readFileSync(movedStub, 'utf-8')).origin.file.path).toBe(
      path.join(input.newRoot, 'pi-agent', 'sessions', 'a.jsonl')
    );
    const movedPlugins = readFileSync(
      path.join(input.newRoot, 'claude', 'plugins', 'installed_plugins.json'),
      'utf-8'
    );
    expect(JSON.parse(movedPlugins).p.installPath).toBe(
      path.join(input.newRoot, 'claude', 'plugins', 'cache', 'p')
    );
    expect(movedPlugins).toContain('\n  ');
  });

  it('re-points the import manifest, and an earlier release index best effort', () => {
    const target = path.join(input.strayRoot, 'pi-agent', 'sessions', 'i.jsonl');
    write(target, '{}');
    write(
      path.join(input.userDataDir, 'legacy-import-manifest.json'),
      JSON.stringify({ entries: [{ targetSessionFile: target }] })
    );
    const priorUserData = path.join(sandbox, 'appData', 'jyw-ai-client');
    write(
      path.join(priorUserData, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ sessionId: 'p', runtimeIdentity: target }])
    );
    const brokenUserData = path.join(sandbox, 'appData', 'AiClient');
    write(path.join(brokenUserData, SESSION_INDEX_FILE_NAME), 'not json');

    expect(
      relocateHomeEnvAppState({ ...input, extraIndexDirs: [priorUserData, brokenUserData] })
    ).toMatchObject({ kind: 'relocated', indexPathsRewritten: 2, strayRemoved: true });
    const moved = path.join(input.newRoot, 'pi-agent', 'sessions', 'i.jsonl');
    const manifest = JSON.parse(
      readFileSync(path.join(input.userDataDir, 'legacy-import-manifest.json'), 'utf-8')
    );
    expect(manifest.entries[0].targetSessionFile).toBe(moved);
    const [priorRow] = JSON.parse(
      readFileSync(path.join(priorUserData, SESSION_INDEX_FILE_NAME), 'utf-8')
    );
    expect(priorRow.runtimeIdentity).toBe(moved);
  });

  it('matches a HOME spelled with `..` the way path.join wrote the rows', () => {
    const unnormalized = [sandbox, 'elsewhere', '..', 'SPB_Data', APP_STATE_DIR, 'PiLabAi'].join(
      '/'
    );
    const file = path.join(input.strayRoot, 'pi-agent', 'z.jsonl');
    write(file, 'z');
    write(
      path.join(input.userDataDir, SESSION_INDEX_FILE_NAME),
      JSON.stringify([{ sessionId: 'z', runtimeIdentity: file }])
    );

    expect(relocateHomeEnvAppState({ ...input, strayRoot: unnormalized })).toMatchObject({
      kind: 'relocated',
      indexPathsRewritten: 1,
      strayRemoved: true,
    });
    expect(readFileSync(String(readIndex()[0].runtimeIdentity), 'utf-8')).toBe('z');
  });

  it('moves `.aiclient` out of HOME without ever touching HOME itself', () => {
    const bareHome = path.join(sandbox, 'BareHome');
    write(path.join(bareHome, '.aiclient', 'settings.json'), '{}');

    expect(
      relocateHomeEnvAppState({
        ...input,
        strayRoot: [bareHome, '.aiclient'].join('/'),
        newRoot: path.join(sandbox, 'profile', '.aiclient'),
      })
    ).toMatchObject({ kind: 'relocated', strayRemoved: true });
    expect(existsSync(bareHome)).toBe(true);
    expect(existsSync(path.join(sandbox, 'profile', '.aiclient', 'settings.json'))).toBe(true);
  });

  it('never carries the marker into another root through a migration copy', () => {
    const legacy = path.join(sandbox, 'profile', '.aiclient');
    write(path.join(legacy, 'settings.json'), '{}');
    write(path.join(legacy, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'legacy');

    migrateAppState({
      legacyRoot: legacy,
      legacyCredentialsDir: path.join(sandbox, 'none'),
      newRoot: input.newRoot,
      newCredentialsDir: path.join(input.newRoot, 'credentials'),
    });
    expect(existsSync(path.join(input.newRoot, 'settings.json'))).toBe(true);
    expect(existsSync(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME))).toBe(false);
  });

  it('when a leftover cannot be merged, keeps both and stays on the relocated root', () => {
    write(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'done');
    write(path.join(input.newRoot, 'credentials', 'vault.json'), 'real');
    const locked = path.join(input.strayRoot, 'pi-agent', 'locked.jsonl');
    write(locked, 'x');
    chmodSync(locked, 0o000);

    try {
      expect(relocateHomeEnvAppState(input)).toMatchObject({ kind: 'leftover_kept' });
    } finally {
      chmodSync(locked, 0o600);
    }
    expect(
      readFileSync(path.join(input.newRoot, HOME_ENV_RELOCATION_MARKER_FILE_NAME), 'utf-8')
    ).toBe('done');
    expect(readFileSync(path.join(input.newRoot, 'credentials', 'vault.json'), 'utf-8')).toBe(
      'real'
    );
    expect(readFileSync(locked, 'utf-8')).toBe('x');
  });

  it('when the file index lies, its own marker still stops it deleting the root', () => {
    const profile = path.join(sandbox, 'profile');
    const alias = path.join(sandbox, 'PROFIL~1');
    write(path.join(input.newRoot, 'credentials', 'vault.json'), '{"v":1}');
    symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fsFault.untrustedFileIndex = true;

    const outcome = relocateHomeEnvAppState({
      ...input,
      strayRoot: [alias, APP_STATE_DIR, 'PiLabAi'].join('/'),
    });
    expect(outcome).toMatchObject({ kind: 'relocated', strayRemoved: false });
    expect(readFileSync(path.join(input.newRoot, 'credentials', 'vault.json'), 'utf-8')).toBe(
      '{"v":1}'
    );
    // And the next boot recognises it outright.
    expect(
      relocateHomeEnvAppState({ ...input, strayRoot: [alias, APP_STATE_DIR, 'PiLabAi'].join('/') })
    ).toEqual({ kind: 'skipped', reason: 'same_directory' });
  });
});

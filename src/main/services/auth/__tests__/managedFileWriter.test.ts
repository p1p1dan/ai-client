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
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetManagedFileWriterQueuesForTests, writeSettingsFile } from '../managedFileWriter';

describe('managedFileWriter (D47 S2a §1/§2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'managed-file-writer-'));
    resetManagedFileWriterQueuesForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function settingsPath(): string {
    return path.join(dir, 'nested', 'settings.json');
  }

  function readJson(p: string): Record<string, unknown> {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  }

  it('creates a brand-new file from the mutator when absent (also creates missing dirs)', async () => {
    const p = settingsPath();
    await writeSettingsFile(p, (current) => ({ ...current, env: { A: '1' }, autoUpdates: false }));
    expect(readJson(p)).toEqual({ env: { A: '1' }, autoUpdates: false });
  });

  it('read-latest-then-patch: preserves foreign keys the mutator does not own', async () => {
    const p = settingsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ hooks: { Stop: ['x'] }, theme: 'dark' }), 'utf-8');

    await writeSettingsFile(p, (current) => ({ ...current, env: { A: '1' } }));

    expect(readJson(p)).toEqual({ hooks: { Stop: ['x'] }, theme: 'dark', env: { A: '1' } });
  });

  it('two-mutator race for the same path: both sentinels survive (D47 S2a §3-1 concurrent interleave)', async () => {
    const p = settingsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({}), 'utf-8');

    const generatorWrite = writeSettingsFile(p, (current) => ({
      ...current,
      env: { ANTHROPIC_AUTH_TOKEN: 'sentinel-env' },
    }));
    const hookWrite = writeSettingsFile(p, (current) => ({
      ...current,
      hooks: { Stop: ['sentinel-hook'] },
    }));
    const statusLineWrite = writeSettingsFile(p, (current) => ({
      ...current,
      statusLine: { type: 'sentinel-statusline' },
    }));

    await Promise.all([generatorWrite, hookWrite, statusLineWrite]);

    const final = readJson(p);
    expect((final.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe('sentinel-env');
    expect((final.hooks as { Stop: string[] }).Stop).toEqual(['sentinel-hook']);
    expect((final.statusLine as { type: string }).type).toBe('sentinel-statusline');
  });

  it('corrupt JSON: backs up original bytes to .corrupt-<ts> and rebuilds from {}', async () => {
    const p = settingsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{not valid json', 'utf-8');

    await writeSettingsFile(p, (current) => ({ ...current, env: { A: '1' } }));

    expect(readJson(p)).toEqual({ env: { A: '1' } });

    const backups = readdirSync(path.dirname(p)).filter((f: string) =>
      f.startsWith('settings.json.corrupt-')
    );
    expect(backups.length).toBe(1);
    const backupRaw = readFileSync(path.join(path.dirname(p), backups[0]), 'utf-8');
    expect(backupRaw).toBe('{not valid json');
  });

  it('a non-object JSON value (array) is treated as corrupt and rebuilt', async () => {
    const p = settingsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify([1, 2, 3]), 'utf-8');

    await writeSettingsFile(p, (current) => ({ ...current, env: {} }));
    expect(readJson(p)).toEqual({ env: {} });
  });

  it.skipIf(process.platform === 'win32')(
    'writes end up 0600 even with a stale 0644 tmp file left behind',
    async () => {
      const p = settingsPath();
      mkdirSync(path.dirname(p), { recursive: true });
      const staleTmp = `${p}.999999.stale.tmp`;
      writeFileSync(staleTmp, '{}', { encoding: 'utf-8', mode: 0o644 });

      await writeSettingsFile(p, (current) => ({ ...current, env: {} }));

      const mode = statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
      // The stale tmp is untouched (each write uses a fresh random suffix) —
      // still present, still 0644, proving it wasn't what got renamed.
      expect(existsSync(staleTmp)).toBe(true);
    }
  );

  it('no residual tmp file survives a successful write', async () => {
    const p = settingsPath();
    await writeSettingsFile(p, (current) => ({ ...current, env: {} }));

    const entries = readdirSync(path.dirname(p));
    const tmps = entries.filter((f: string) => f.includes('.tmp'));
    expect(tmps).toEqual([]);
  });

  it('serializes writes to different paths independently (no cross-path blocking)', async () => {
    const pA = path.join(dir, 'a', 'settings.json');
    const pB = path.join(dir, 'b', 'settings.json');

    await Promise.all([
      writeSettingsFile(pA, (current) => ({ ...current, id: 'a' })),
      writeSettingsFile(pB, (current) => ({ ...current, id: 'b' })),
    ]);

    expect(readJson(pA)).toEqual({ id: 'a' });
    expect(readJson(pB)).toEqual({ id: 'b' });
  });

  it('a mutator can no-op (return current unchanged) without corrupting the file', async () => {
    const p = settingsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ autoUpdates: false }), 'utf-8');

    await writeSettingsFile(p, (current) =>
      current.autoUpdates === false ? current : { ...current, autoUpdates: false }
    );

    expect(readJson(p)).toEqual({ autoUpdates: false });
  });
});

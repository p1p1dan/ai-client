import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateManagedCodexConfigToml } from '@shared/codexManagedConfig';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateCodexHomeSidecarStamp,
  getManagedCodexHomeDir,
  regenerateManagedCodexHome,
} from '../codexHome';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

/**
 * D47 S34 spec rev.2 §2 S3b — the Main-side codex-home materialization
 * (`config.toml` + sidecar + stale `auth.json` cleanup). Pure module: no
 * `electron` mock needed, every path is a plain string parameter.
 */

describe('codexHome (D47 S3b §2)', () => {
  let userDataDir: string;

  beforeEach(() => {
    resetManagedFileWriterQueuesForTests();
    userDataDir = mkdtempSync(join(tmpdir(), 'codex-home-userdata-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  function codexHomeDir(): string {
    return join(userDataDir, 'codex-home');
  }

  function configPath(): string {
    return join(codexHomeDir(), 'config.toml');
  }

  function sidecarPath(): string {
    return join(codexHomeDir(), '.aiclient-generated');
  }

  function authPath(): string {
    return join(codexHomeDir(), 'auth.json');
  }

  it('getManagedCodexHomeDir joins <userData>/codex-home', () => {
    expect(getManagedCodexHomeDir('/some/userdata')).toBe(join('/some/userdata', 'codex-home'));
  });

  describe('credentials present (startup vault-ok / login)', () => {
    it('writes config.toml byte-identical to generateManagedCodexConfigToml', async () => {
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://vault.example.com/v1' },
      });

      const written = readFileSync(configPath(), 'utf-8');
      expect(written).toBe(
        generateManagedCodexConfigToml({ baseUrl: 'https://vault.example.com/v1' })
      );
    });

    it('writes the sidecar with mode:"managed", the correct source, and an ISO timestamp', async () => {
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'startup',
        credentials: { baseUrl: 'https://vault.example.com/v1' },
      });

      const sidecar = JSON.parse(readFileSync(sidecarPath(), 'utf-8'));
      expect(sidecar.mode).toBe('managed');
      expect(sidecar.source).toBe('startup');
      expect(typeof sidecar.generatedAt).toBe('string');
      expect(new Date(sidecar.generatedAt).toISOString()).toBe(sidecar.generatedAt);
    });

    it('login source is recorded on the sidecar distinctly from startup', async () => {
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://vault.example.com/v1' },
      });
      const sidecar = JSON.parse(readFileSync(sidecarPath(), 'utf-8'));
      expect(sidecar.source).toBe('login');
    });

    it('deletes a stale auth.json copy', async () => {
      mkdirSync(codexHomeDir(), { recursive: true });
      writeFileSync(authPath(), JSON.stringify({ OPENAI_API_KEY: 'stale-copy' }), 'utf-8');
      expect(existsSync(authPath())).toBe(true);

      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://vault.example.com/v1' },
      });

      expect(existsSync(authPath())).toBe(false);
    });

    it('creates config.toml/sidecar as 0600 (POSIX)', async () => {
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://vault.example.com/v1' },
      });

      if (process.platform !== 'win32') {
        expect(statSync(configPath()).mode & 0o777).toBe(0o600);
        expect(statSync(sidecarPath()).mode & 0o777).toBe(0o600);
      }
    });

    it('a second regenerate with a new baseUrl fully replaces config.toml content (no merge — this file has no foreign keys)', async () => {
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://old.example.com/v1' },
      });
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://new.example.com/v1' },
      });

      const written = readFileSync(configPath(), 'utf-8');
      expect(written).toBe(
        generateManagedCodexConfigToml({ baseUrl: 'https://new.example.com/v1' })
      );
      expect(written).not.toContain('old.example.com');
    });

    it('leaves no residual .tmp files behind after a write', async () => {
      await regenerateManagedCodexHome({
        userDataDir,
        source: 'login',
        credentials: { baseUrl: 'https://vault.example.com/v1' },
      });

      const { readdirSync } = await import('node:fs');
      const leftovers = readdirSync(codexHomeDir()).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('credentials null (startup vault-non-ok / the logout contract)', () => {
    it('does not create config.toml/sidecar when neither existed', async () => {
      await regenerateManagedCodexHome({ userDataDir, source: 'startup', credentials: null });

      expect(existsSync(configPath())).toBe(false);
      expect(existsSync(sidecarPath())).toBe(false);
    });

    it('leaves an existing config.toml byte-for-byte untouched ("config 保留既有字节")', async () => {
      mkdirSync(codexHomeDir(), { recursive: true });
      const existingBytes = generateManagedCodexConfigToml({
        baseUrl: 'https://existing.example.com/v1',
      });
      writeFileSync(configPath(), existingBytes, 'utf-8');

      await regenerateManagedCodexHome({ userDataDir, source: 'startup', credentials: null });

      expect(readFileSync(configPath(), 'utf-8')).toBe(existingBytes);
    });

    it('leaves an existing sidecar untouched too', async () => {
      mkdirSync(codexHomeDir(), { recursive: true });
      const existingSidecar = `${JSON.stringify(
        generateCodexHomeSidecarStamp('login', '2026-01-01T00:00:00.000Z'),
        null,
        2
      )}\n`;
      writeFileSync(sidecarPath(), existingSidecar, 'utf-8');

      await regenerateManagedCodexHome({ userDataDir, source: 'startup', credentials: null });

      expect(readFileSync(sidecarPath(), 'utf-8')).toBe(existingSidecar);
    });

    it('still deletes a stale auth.json — the logout / vault-non-ok contract is "config stays", not "nothing happens"', async () => {
      mkdirSync(codexHomeDir(), { recursive: true });
      writeFileSync(authPath(), JSON.stringify({ OPENAI_API_KEY: 'stale-copy' }), 'utf-8');

      await regenerateManagedCodexHome({ userDataDir, source: 'startup', credentials: null });

      expect(existsSync(authPath())).toBe(false);
    });

    it('is a no-op (does not throw) when codex-home does not exist yet at all', async () => {
      await expect(
        regenerateManagedCodexHome({ userDataDir, source: 'startup', credentials: null })
      ).resolves.toBeUndefined();
      expect(existsSync(codexHomeDir())).toBe(false);
    });
  });
});

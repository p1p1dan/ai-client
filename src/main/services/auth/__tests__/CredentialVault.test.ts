import {
  chmodSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialVault, type VaultCrypto, type VaultPayload } from '../CredentialVault';

// ESM module namespaces are not configurable, so `vi.spyOn(fsModule, 'chmodSync')`
// cannot work directly — `vi.mock` with `importOriginal` replaces module
// resolution instead, wrapping `chmodSync` in a `vi.fn` that still delegates
// to the real implementation (every other test in this file needs the real
// filesystem side effects; only the "1c, 1d" test inspects the call args).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

/**
 * D47 S1 spec §3 test group 1 — pure module, `mkdtemp` + fake crypto, zero
 * `electron` import. Covers 1a–1f, 1h lives in `index.test.ts` (it exercises
 * the electron-binding lazy factory, not this class), and 1g lives in
 * `vaultIntegration.test.ts` (it needs a real `OnboardingService` run to
 * compare vault vs legacy-file bytes).
 */

const VAULT_FILE = 'vault.json';

function fakeAvailableCrypto(): VaultCrypto {
  // encrypt/decrypt are the identity function on purpose: it keeps the
  // written payload human-readable in assertions, and correctness of the
  // *shape* (payload is a base64/opaque string vs. a plain object) is what
  // matters here, not real cryptography.
  return {
    available: () => true,
    encrypt: (plainText) => plainText,
    decrypt: (cipherText) => cipherText,
  };
}

function fakeUnavailableCrypto(): VaultCrypto {
  return {
    available: () => false,
    encrypt: () => {
      throw new Error('encrypt should never be called when unavailable');
    },
    decrypt: () => {
      throw new Error('decrypt should never be called when unavailable');
    },
  };
}

function makePayload(overrides?: Partial<VaultPayload>): VaultPayload {
  return {
    identity: { email: 'user@jcdz.cc', userId: 1 },
    cchBaseUrl: 'https://cch.example.com',
    claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'claude-secret-token' },
    codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'codex-secret-key' },
    receivedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'aiclient-vault-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(baseDir, { recursive: true, force: true });
});

describe('CredentialVault — roundtrip (1a)', () => {
  it('round-trips a payload through the safeStorage-shaped adapter', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());

    const payload = makePayload();
    const saveResult = await vault.save(payload);
    expect(saveResult).toEqual({ ok: true });

    const result = vault.read();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.doc.enc).toBe('safeStorage');
      expect(result.doc.payload).toEqual(payload);
    }
  });

  it('round-trips a payload through the none adapter when crypto is unavailable', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeUnavailableCrypto());

    const payload = makePayload();
    const saveResult = await vault.save(payload);
    expect(saveResult).toEqual({ ok: true });

    const result = vault.read();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.doc.enc).toBe('none');
      expect(result.doc.encReason).toBe('unavailable');
      expect(result.doc.payload).toEqual(payload);
    }
  });

  // D47 S6 §1.4 — `identity.userId` was widened from `number` to
  // `number | null` (adoption never has a real numeric id to put there).
  // Double-test: null persists through save/read, AND a numeric id from a
  // real login still round-trips unchanged — neither arm is allowed to
  // regress the other.
  it('round-trips a null userId (adoption payload shape) without coercion', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());

    const payload = makePayload({ identity: { email: 'user@jcdz.cc', userId: null } });
    await vault.save(payload);

    const result = vault.read();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.doc.payload.identity.userId).toBeNull();
    }
  });

  it('round-trips a numeric userId (real-login payload shape) without loss', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());

    const payload = makePayload({ identity: { email: 'user@jcdz.cc', userId: 42 } });
    await vault.save(payload);

    const result = vault.read();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.doc.payload.identity.userId).toBe(42);
    }
  });
});

describe('CredentialVault — clear (1b)', () => {
  it('keeps lastEmail, recursively wipes the secret, and never creates an empty shell for an absent vault', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());

    const sentinel = 'SENTINEL-SECRET-9f3c1a';
    const payload = makePayload({
      claude: { baseUrl: 'https://cch.example.com/v1', authToken: sentinel },
    });
    await vault.save(payload);

    await vault.clear({ keepLastEmail: true });

    const raw = readFileSync(join(baseDir, VAULT_FILE), 'utf-8');
    expect(raw).not.toContain(sentinel);
    const parsed = JSON.parse(raw) as { lastEmail: string | null; payload: unknown };
    expect(parsed.lastEmail).toBe('user@jcdz.cc');
    expect(parsed.payload).toBeNull();

    // D47 S5 §1.1: a cleared-but-existing vault reads as its own `cleared`
    // status now — `absent` is reserved for "no vault file at all" (S1
    // as-built deviation 3, paid down here).
    const readResult = vault.read();
    expect(readResult).toEqual({ status: 'cleared', lastEmail: 'user@jcdz.cc' });
  });

  it('is a no-op when the vault file does not exist — never creates a lastEmail-only shell', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aiclient-vault-empty-'));
    try {
      const vault = new CredentialVault({ baseDir: emptyDir, crypto: fakeAvailableCrypto() });
      vault.promoteCrypto(fakeAvailableCrypto());

      await vault.clear({ keepLastEmail: true });

      expect(existsSync(emptyDir)).toBe(true); // mkdtemp already made it
      expect(existsSync(join(emptyDir, VAULT_FILE))).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('CredentialVault — file permissions (1c, 1d)', () => {
  it('writes the vault file at 0600 and the directory at 0700, verified both by real statSync and by the chmodSync call arguments', async () => {
    vi.mocked(chmodSync).mockClear();
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());

    await vault.save(makePayload());

    // Layer 1: real POSIX permission bits (skipped on win32, where mode bits are meaningless).
    if (process.platform !== 'win32') {
      const dirMode = statSync(baseDir).mode & 0o777;
      const fileMode = statSync(join(baseDir, VAULT_FILE)).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    // Layer 2: platform-independent — the exact arguments CredentialVault passed to chmodSync.
    expect(vi.mocked(chmodSync)).toHaveBeenCalledWith(baseDir, 0o700);
    expect(vi.mocked(chmodSync)).toHaveBeenCalledWith(join(baseDir, VAULT_FILE), 0o600);
  });

  it('overwrites a stale tmp file left at 0644 with 0600 (A-track B5)', async () => {
    const fixedRandom = 0.123456789;
    vi.spyOn(Math, 'random').mockReturnValue(fixedRandom);
    const expectedSuffix = fixedRandom.toString(36).slice(2, 10);
    mkdirSync(baseDir, { recursive: true });
    const staleTmpPath = join(baseDir, `${VAULT_FILE}.${process.pid}.${expectedSuffix}.tmp`);
    writeFileSync(staleTmpPath, '{}', { mode: 0o644 });

    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());
    const result = await vault.save(makePayload());
    expect(result).toEqual({ ok: true });

    if (process.platform !== 'win32') {
      const fileMode = statSync(join(baseDir, VAULT_FILE)).mode & 0o777;
      expect(fileMode).toBe(0o600);
    }
  });
});

describe('CredentialVault — read result union (1e)', () => {
  it('malformed JSON is invalid/malformed_json', () => {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, VAULT_FILE), 'not json{{{');

    const vault = new CredentialVault({ baseDir, crypto: fakeAvailableCrypto() });
    expect(vault.read()).toEqual({ status: 'invalid', reason: 'malformed_json' });
  });

  it('a decrypt throw is invalid/decrypt_failed', async () => {
    const throwingCrypto: VaultCrypto = {
      available: () => true,
      encrypt: (plainText) => plainText, // identity — the envelope holds valid JSON as "ciphertext"
      decrypt: () => {
        throw new Error('bad ciphertext');
      },
    };
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(throwingCrypto);
    await vault.save(makePayload());

    expect(vault.read()).toEqual({
      status: 'invalid',
      reason: 'decrypt_failed',
      lastEmail: 'user@jcdz.cc',
    });
  });

  it('enc:"safeStorage" with an unavailable adapter is locked, never invalid', () => {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(
      join(baseDir, VAULT_FILE),
      JSON.stringify({
        version: 1,
        enc: 'safeStorage',
        lastEmail: 'locked@jcdz.cc',
        invalidatedAt: null,
        encReason: 'ok',
        payload: 'opaque-ciphertext',
      })
    );

    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    expect(vault.read()).toEqual({ status: 'locked', lastEmail: 'locked@jcdz.cc' });
  });

  it('version > 1 is unsupported, read-only, and leaves the file bytes untouched', async () => {
    mkdirSync(baseDir, { recursive: true });
    const vaultPath = join(baseDir, VAULT_FILE);
    writeFileSync(
      vaultPath,
      JSON.stringify({
        version: 2,
        enc: 'none',
        lastEmail: 'future@jcdz.cc',
        invalidatedAt: null,
        encReason: 'ok',
        payload: { future: 'shape' },
      })
    );
    const originalBytes = readFileSync(vaultPath, 'utf-8');

    const vault = new CredentialVault({ baseDir, crypto: fakeAvailableCrypto() });
    expect(vault.read()).toEqual({ status: 'unsupported', lastEmail: 'future@jcdz.cc' });
    expect(readFileSync(vaultPath, 'utf-8')).toBe(originalBytes);

    // Save must also refuse to overwrite an unsupported on-disk schema.
    vault.promoteCrypto(fakeAvailableCrypto());
    const saveResult = await vault.save(makePayload());
    expect(saveResult).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(readFileSync(vaultPath, 'utf-8')).toBe(originalBytes);
  });

  it('a missing/non-numeric version is invalid/schema_invalid', () => {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, VAULT_FILE), JSON.stringify({ enc: 'none', payload: {} }));

    const vault = new CredentialVault({ baseDir, crypto: fakeAvailableCrypto() });
    expect(vault.read()).toEqual({ status: 'invalid', reason: 'schema_invalid' });
  });
});

describe('CredentialVault — promotion latch (1f)', () => {
  it('refuses save before promotion, allows it after, is idempotent, and never calls available() during promotion itself', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });

    const refused = await vault.save(makePayload());
    expect(refused).toEqual({ ok: false, reason: 'crypto_not_ready' });

    const availableSpy = vi.fn(() => true);
    const crypto1: VaultCrypto = {
      available: availableSpy,
      encrypt: (s) => s,
      decrypt: (s) => s,
    };
    vault.promoteCrypto(crypto1);
    expect(availableSpy).not.toHaveBeenCalled();

    const allowed = await vault.save(makePayload());
    expect(allowed).toEqual({ ok: true });
    expect(availableSpy).toHaveBeenCalledTimes(1);

    // Repeated promotion with a different adapter is a no-op: crypto2 must
    // never be installed or consulted.
    const crypto2AvailableSpy = vi.fn(() => false);
    const crypto2: VaultCrypto = {
      available: crypto2AvailableSpy,
      encrypt: () => 'x',
      decrypt: () => 'x',
    };
    vault.promoteCrypto(crypto2);

    const secondSave = await vault.save(makePayload());
    expect(secondSave).toEqual({ ok: true });
    expect(crypto2AvailableSpy).not.toHaveBeenCalled();
    // The cached `available()` result from crypto1 is reused — no second call either.
    expect(availableSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CredentialVault — markInvalidated / rejected (D47 S5 §1.1)', () => {
  it('flips invalidatedAt and reports rejected on the next read, leaving payload bytes untouched', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());
    const payload = makePayload();
    await vault.save(payload);

    const beforeBytes = readFileSync(join(baseDir, VAULT_FILE), 'utf-8');
    const beforePayloadField = (JSON.parse(beforeBytes) as { payload: unknown }).payload;

    await vault.markInvalidated('2026-08-15T12:00:00.000Z');

    const afterBytes = readFileSync(join(baseDir, VAULT_FILE), 'utf-8');
    const afterParsed = JSON.parse(afterBytes) as { payload: unknown; invalidatedAt: string };
    expect(afterParsed.invalidatedAt).toBe('2026-08-15T12:00:00.000Z');
    // Payload bytes are byte-for-byte unchanged — markInvalidated never touches them.
    expect(afterParsed.payload).toEqual(beforePayloadField);

    expect(vault.read()).toEqual({ status: 'rejected', lastEmail: 'user@jcdz.cc' });
  });

  it('rejected outranks a still-decryptable ok payload', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());
    await vault.save(makePayload());

    expect(vault.read().status).toBe('ok');
    await vault.markInvalidated('2026-08-15T12:00:00.000Z');
    expect(vault.read().status).toBe('rejected');
  });

  it('is a safe no-op when no vault file exists', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'aiclient-vault-mark-empty-'));
    try {
      const vault = new CredentialVault({ baseDir: emptyDir, crypto: fakeAvailableCrypto() });
      await vault.markInvalidated('2026-08-15T12:00:00.000Z');
      expect(existsSync(join(emptyDir, VAULT_FILE))).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('works even when crypto was never promoted (locked keyring) — never touches crypto', async () => {
    const vault = new CredentialVault({ baseDir, crypto: fakeAvailableCrypto() });
    vault.promoteCrypto(fakeAvailableCrypto());
    await vault.save(makePayload());

    const lockedVault = new CredentialVault({ baseDir, crypto: fakeUnavailableCrypto() });
    await lockedVault.markInvalidated('2026-08-15T12:00:00.000Z');

    expect(lockedVault.read()).toEqual({ status: 'rejected', lastEmail: 'user@jcdz.cc' });
  });
});

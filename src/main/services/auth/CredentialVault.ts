/**
 * D47 S1 — the credential vault file (`<userData>/credentials/vault.json`).
 *
 * Pure module, zero `electron` import: every filesystem root and every crypto
 * capability is injected through the constructor. Tests import this file
 * directly against an `mkdtemp` directory and a fake `VaultCrypto`; the only
 * place that touches `electron` (`app.getPath`, `safeStorage`) is `index.ts`,
 * which owns the lazy singleton factory (S1 spec §1, A-track B1/M5).
 *
 * ## Why `save()` refuses before promotion
 *
 * At boot we don't yet know whether `safeStorage` will be available — calling
 * `isEncryptionAvailable()` before the first `BrowserWindow` exists hangs
 * forever on this repo's Electron build (E6). So the vault starts with an
 * inert crypto adapter and `save()` unconditionally refuses
 * (`crypto_not_ready`) until `promoteCrypto()` installs the real adapter after
 * the first window is created. Refusing beats writing plaintext that a later,
 * encryption-capable write would have avoided (S1 spec §2.1, A-track B3).
 *
 * ## Why `available()` is cached, not called during promotion
 *
 * `promoteCrypto()` only swaps the adapter reference; it never calls
 * `.available()` itself. The first real read/save call evaluates it once and
 * caches the boolean, so a promoted-but-unused vault never pays for (or
 * risks) an extra `isEncryptionAvailable()` round trip (S1 spec §2.2).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VAULT_FILE_NAME = 'vault.json';
const SCHEMA_VERSION = 1;

/** Crypto capability the vault writes/reads through — real adapter is `safeStorage`, injected by `index.ts`. */
export interface VaultCrypto {
  available(): boolean;
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

/**
 * The decrypted (or, on `enc:"none"`, plain) contents of the vault payload.
 *
 * `identity.userId` — D47 S6 §1.1: relaxed from `number` to `number|null`.
 * Adoption (`adoption.ts`) never has a real numeric id to put here (the
 * legacy on-disk sources it reads carry no id field, and a probe response's
 * body is deliberately never parsed for one — "probe 200 回填 id" was
 * considered and rejected, A-m2), so an adopted payload always saves
 * `userId: null`. A real login (`OnboardingService.verifyAndRegister`) still
 * gets the server-issued numeric id.
 */
export interface VaultPayload {
  identity: { email: string; userId: number | null };
  cchBaseUrl: string;
  claude: { baseUrl: string; authToken: string };
  codex: { baseUrl: string; apiKey: string };
  /** Phase 5 / S4: Pi reuses the company key but keeps its own future-proof arm. */
  pi?: { baseUrl: string; apiKey: string };
  receivedAt: string;
}

/** On-disk envelope, `payload` decrypted and parsed. What a `status:'ok'` read hands back. */
export interface VaultDoc {
  version: number;
  enc: 'safeStorage' | 'none';
  lastEmail: string | null;
  invalidatedAt: string | null;
  encReason: 'ok' | 'unavailable';
  payload: VaultPayload;
}

/**
 * Read outcome union (S1 spec §2.1, A-track B2 + B-track 1.5 合取; D47 S5
 * §1.1 adds `rejected`/`cleared`). `locked` is a TEMPORARY state
 * (keyring/session not unlocked yet) and must never be confused with
 * `invalid` (a permanently broken file) — see `enc:'safeStorage'` handling
 * below.
 *
 * `rejected` (`invalidatedAt` non-null, set by `markInvalidated()`) is
 * checked BEFORE everything else that would otherwise decode to `ok` — a
 * probe-confirmed KEY_INVALID must never be masked by a payload that still
 * happens to decrypt fine. `cleared` (`payload: null`, set by `clear()`)
 * REPLACES the S1 `absent` folding for a vault file that exists but was
 * explicitly wiped by logout — `absent` now means "no vault file at all"
 * exclusively (S1 as-built deviation 3, paid down here).
 */
export type VaultReadResult =
  | { status: 'ok'; doc: VaultDoc }
  | { status: 'absent' }
  | { status: 'cleared'; lastEmail: string | null }
  | { status: 'rejected'; lastEmail: string | null }
  | { status: 'locked'; lastEmail?: string | null }
  | { status: 'unsupported'; lastEmail?: string | null }
  | {
      status: 'invalid';
      reason: 'malformed_json' | 'schema_invalid' | 'decrypt_failed';
      lastEmail?: string | null;
    };

export type VaultSaveResult =
  | { ok: true }
  | { ok: false; reason: 'crypto_not_ready' | 'unsupported_version' };

interface RawEnvelope {
  version: number;
  enc: 'safeStorage' | 'none';
  lastEmail: string | null;
  invalidatedAt: string | null;
  encReason: 'ok' | 'unavailable';
  payload: string | Record<string, unknown> | null;
}

function validateEnvelopeShape(
  value: unknown
): { ok: true; envelope: RawEnvelope } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.version !== 'number' || Number.isNaN(obj.version)) {
    return { ok: false };
  }
  if (obj.enc !== 'safeStorage' && obj.enc !== 'none') {
    return { ok: false };
  }
  const payload =
    typeof obj.payload === 'string' || (obj.payload && typeof obj.payload === 'object')
      ? (obj.payload as string | Record<string, unknown>)
      : null;
  return {
    ok: true,
    envelope: {
      version: obj.version,
      enc: obj.enc,
      lastEmail: typeof obj.lastEmail === 'string' ? obj.lastEmail : null,
      invalidatedAt: typeof obj.invalidatedAt === 'string' ? obj.invalidatedAt : null,
      encReason: obj.encReason === 'unavailable' ? 'unavailable' : 'ok',
      payload,
    },
  };
}

/** Random-enough, mockable (via `Math.random`) tmp-file suffix — tests use this to force a stale-tmp-permission collision (S1 spec §3-1d). */
function randomTmpSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface CredentialVaultOptions {
  baseDir: string;
  crypto: VaultCrypto;
}

export class CredentialVault {
  private readonly baseDir: string;
  private readonly vaultPath: string;
  private crypto: VaultCrypto;
  private promoted = false;
  private cachedAvailable: boolean | null = null;
  /** Process-internal serialization for save/clear (S1 spec §2.1) — a Promise chain, not a lock file. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: CredentialVaultOptions) {
    this.baseDir = options.baseDir;
    this.vaultPath = join(options.baseDir, VAULT_FILE_NAME);
    this.crypto = options.crypto;
  }

  /**
   * One-way, idempotent latch: the first call installs `crypto` and unlocks
   * `save()`; every later call (with any argument) is a no-op. Never calls
   * `crypto.available()` — that happens lazily on first actual use.
   */
  promoteCrypto(crypto: VaultCrypto): void {
    if (this.promoted) {
      return;
    }
    this.promoted = true;
    this.crypto = crypto;
    this.cachedAvailable = null;
  }

  private isCryptoAvailable(): boolean {
    if (this.cachedAvailable === null) {
      this.cachedAvailable = this.crypto.available();
    }
    return this.cachedAvailable;
  }

  private runSerialized<T>(task: () => T): Promise<T> {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Synchronous — reads never queue behind writes; the atomic rename in `writeEnvelope` keeps every read consistent. */
  read(): VaultReadResult {
    if (!existsSync(this.vaultPath)) {
      return { status: 'absent' };
    }

    let raw: string;
    try {
      raw = readFileSync(this.vaultPath, 'utf-8');
    } catch {
      return { status: 'absent' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'invalid', reason: 'malformed_json' };
    }

    const validation = validateEnvelopeShape(parsed);
    if (!validation.ok) {
      return { status: 'invalid', reason: 'schema_invalid' };
    }
    const envelope = validation.envelope;

    if (envelope.version > SCHEMA_VERSION) {
      // Read-only, never overwritten — a future schema version may hold data
      // this build cannot interpret; overwriting it would destroy that data.
      return { status: 'unsupported', lastEmail: envelope.lastEmail };
    }

    // D47 S5 §1.1: `rejected` outranks everything below it, including a
    // payload that still decrypts fine — a probe-confirmed KEY_INVALID must
    // never be masked by `ok`. Checked before the `cleared` branch too (the
    // two are mutually exclusive in practice — `clear()` always resets
    // `invalidatedAt` to null — but this ordering stays correct even if that
    // ever changes).
    if (envelope.invalidatedAt !== null) {
      return { status: 'rejected', lastEmail: envelope.lastEmail };
    }

    if (envelope.payload === null) {
      // Cleared vault (logout): no credential payload, only lastEmail
      // survives on disk. D47 S5 §1.1: this is now its own `cleared` status,
      // no longer folded into `absent` (S1 as-built deviation 3) — `absent`
      // means "no vault file on disk at all".
      return { status: 'cleared', lastEmail: envelope.lastEmail };
    }

    if (envelope.enc === 'safeStorage') {
      // A locked keyring/session is a TEMPORARY state, never `invalid`.
      if (!this.isCryptoAvailable()) {
        return { status: 'locked', lastEmail: envelope.lastEmail };
      }
      if (typeof envelope.payload !== 'string') {
        return { status: 'invalid', reason: 'schema_invalid', lastEmail: envelope.lastEmail };
      }
      let decrypted: string;
      try {
        decrypted = this.crypto.decrypt(envelope.payload);
      } catch {
        return { status: 'invalid', reason: 'decrypt_failed', lastEmail: envelope.lastEmail };
      }
      let payload: VaultPayload;
      try {
        payload = JSON.parse(decrypted) as VaultPayload;
      } catch {
        return { status: 'invalid', reason: 'decrypt_failed', lastEmail: envelope.lastEmail };
      }
      return {
        status: 'ok',
        doc: {
          version: envelope.version,
          enc: envelope.enc,
          lastEmail: envelope.lastEmail,
          invalidatedAt: envelope.invalidatedAt,
          encReason: envelope.encReason,
          payload,
        },
      };
    }

    // enc === 'none': payload is stored as a plain object already.
    if (typeof envelope.payload !== 'object') {
      return { status: 'invalid', reason: 'schema_invalid', lastEmail: envelope.lastEmail };
    }
    return {
      status: 'ok',
      doc: {
        version: envelope.version,
        enc: envelope.enc,
        lastEmail: envelope.lastEmail,
        invalidatedAt: envelope.invalidatedAt,
        encReason: envelope.encReason,
        payload: envelope.payload as unknown as VaultPayload,
      },
    };
  }

  save(payload: VaultPayload): Promise<VaultSaveResult> {
    return this.runSerialized(() => this.saveInternal(payload));
  }

  private saveInternal(payload: VaultPayload): VaultSaveResult {
    if (!this.promoted) {
      console.warn(
        '[CredentialVault] save refused: crypto not promoted yet (crypto_not_ready) — refusing beats a silent plaintext downgrade'
      );
      return { ok: false, reason: 'crypto_not_ready' };
    }

    // A newer, unreadable schema version on disk is read-only.
    if (this.read().status === 'unsupported') {
      console.warn('[CredentialVault] save refused: on-disk vault is a newer, unsupported schema');
      return { ok: false, reason: 'unsupported_version' };
    }

    const available = this.isCryptoAvailable();
    const envelope: RawEnvelope = available
      ? {
          version: SCHEMA_VERSION,
          enc: 'safeStorage',
          lastEmail: payload.identity.email,
          invalidatedAt: null,
          encReason: 'ok',
          payload: this.crypto.encrypt(JSON.stringify(payload)),
        }
      : {
          version: SCHEMA_VERSION,
          enc: 'none',
          lastEmail: payload.identity.email,
          invalidatedAt: null,
          encReason: 'unavailable',
          payload: payload as unknown as Record<string, unknown>,
        };

    this.writeEnvelope(envelope);
    return { ok: true };
  }

  /** No flag gate (S1 spec §2.1, A-track B8) — logout must clear the vault regardless of the managed-credentials flag. */
  clear(options: { keepLastEmail: boolean }): Promise<void> {
    return this.runSerialized(() => this.clearInternal(options));
  }

  /**
   * D47 S5 §1.1/§2 — flips the plaintext envelope's `invalidatedAt` field to
   * `iso`, leaving `payload` byte-for-byte untouched (string ciphertext or
   * plain object, whichever it already was). Deliberately does NOT go
   * through `save()`: `save()` requires a promoted, available crypto adapter
   * and re-encrypts the whole payload, but marking a key invalid must work
   * even when the keyring is locked or crypto was never promoted — the
   * secret itself never needs to be read or rewritten for this operation.
   * Serialized through the same write queue as `save()`/`clear()`
   * (A-track B4). Best-effort like `clear()`: a missing/unreadable vault
   * file is a no-op, never a thrown error — the caller
   * (`AuthStateService.markRejected`) must not be blocked by a vault that
   * has nothing to invalidate.
   */
  markInvalidated(iso: string): Promise<void> {
    return this.runSerialized(() => this.markInvalidatedInternal(iso));
  }

  private markInvalidatedInternal(iso: string): void {
    if (!existsSync(this.vaultPath)) {
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(this.vaultPath, 'utf-8');
    } catch (error) {
      console.warn('[CredentialVault] markInvalidated: failed to read existing vault', error);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn('[CredentialVault] markInvalidated: existing vault is not valid JSON', error);
      return;
    }

    const validation = validateEnvelopeShape(parsed);
    if (!validation.ok) {
      console.warn(
        '[CredentialVault] markInvalidated: existing vault has an invalid envelope shape'
      );
      return;
    }

    // Spread the validated envelope verbatim — `payload` (string or object)
    // is carried through unchanged; only `invalidatedAt` moves.
    const envelope: RawEnvelope = { ...validation.envelope, invalidatedAt: iso };
    try {
      this.writeEnvelope(envelope);
    } catch (error) {
      console.warn('[CredentialVault] markInvalidated: failed to write updated vault', error);
    }
  }

  private clearInternal(options: { keepLastEmail: boolean }): void {
    if (!existsSync(this.vaultPath)) {
      // Never create an empty lastEmail-only shell for a vault that never existed.
      return;
    }

    let lastEmail: string | null = null;
    try {
      const raw = readFileSync(this.vaultPath, 'utf-8');
      const validation = validateEnvelopeShape(JSON.parse(raw));
      if (validation.ok && options.keepLastEmail) {
        lastEmail = validation.envelope.lastEmail;
      }
    } catch (error) {
      console.warn(
        '[CredentialVault] clear: existing vault unreadable, wiping without lastEmail recovery',
        error
      );
    }

    const envelope: RawEnvelope = {
      version: SCHEMA_VERSION,
      enc: 'none',
      lastEmail,
      invalidatedAt: null,
      encReason: 'ok',
      payload: null,
    };

    try {
      this.writeEnvelope(envelope);
    } catch (error) {
      // Logout must never fail because the vault could not be wiped — the
      // caller (`OnboardingService.logout`) does not change its return value
      // on vault failure (S1 spec §2.1).
      console.warn('[CredentialVault] clear: failed to write cleared vault', error);
    }
  }

  private writeEnvelope(envelope: RawEnvelope): void {
    mkdirSync(this.baseDir, { recursive: true });
    chmodSync(this.baseDir, 0o700);

    const tmpPath = join(
      this.baseDir,
      `${VAULT_FILE_NAME}.${process.pid}.${randomTmpSuffix()}.tmp`
    );
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;

    // `mode` on writeFileSync only takes effect when the file is CREATED — a
    // stale tmp file left behind by a crashed previous write would silently
    // keep its old permissions without this explicit chmod (A-track B5).
    writeFileSync(tmpPath, serialized, { encoding: 'utf-8' });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.vaultPath);
    chmodSync(this.vaultPath, 0o600);
  }
}

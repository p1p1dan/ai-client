/**
 * The `aiclient-encrypted-read` row's names, the ciphertext marker and its
 * limits (dsh-rebase P1-13c; decision 091).
 *
 * Import-free on purpose, like the loop guard's constants: the bridge and the
 * renderer can take these values without pulling in DSH.
 */

/** Stable Cordis plugin name and bundle row id. */
export const ENCRYPTED_READ_ROW = 'aiclient-encrypted-read';

/**
 * Emergency kill switch, the loop guard's name shape (decision 065's
 * `AICLIENT_RUNTIME_LOOP_GUARD`). Only the exact value `0` turns the row off,
 * in which case it wraps nothing at all and behaves as if the row were not
 * composed. Main strips `AICLIENT_*` from the host's environment and forwards
 * this one explicitly (`dshHostEnvironment.ts`); the row stays in the
 * composition's `REQUIRED_ENABLED` (decision 135 made this switch optional).
 */
export const ENCRYPTED_READ_ENV = 'AICLIENT_RUNTIME_ENCRYPTED_READ';

/**
 * The disk-encryption policy's on-disk ciphertext marker: files the policy
 * encrypted start with these 16 ASCII bytes, `%TSD-Header-###%`. Only the
 * first 16 bytes of a file are ever compared, never a substring search
 * elsewhere in the content (P1-13b).
 */
export const TSD_HEADER = new Uint8Array([
  0x25, 0x54, 0x53, 0x44, 0x2d, 0x48, 0x65, 0x61, 0x64, 0x65, 0x72, 0x2d, 0x23, 0x23, 0x23, 0x25,
]);

/** Bytes of the file prefix the wrapper reads to detect the marker. */
export const HEADER_PREFIX_BYTES = TSD_HEADER.length;

/**
 * The `FsError` code of every refusal this row raises: the file is protected
 * by the disk-encryption policy and cannot be read in plaintext here. One
 * code, whatever the reason (still ciphertext after the fallback, a failed,
 * timed-out or oversized fallback), so callers route one failure class.
 */
export const FS_ENCRYPTED = 'FS_ENCRYPTED';

/**
 * How long one fallback read may run, from the moment its PowerShell process
 * is spawned (a call queued behind the concurrency gate does not consume the
 * budget of the call ahead of it).
 */
export const FALLBACK_TIMEOUT_MS = 10_000;

/**
 * Upper bound on the plaintext one fallback read may return. The fallback
 * reads whole files, so this caps memory for pathologically large encrypted
 * files; `readBytes`' own `maxBytes` (checked against this plaintext) stays
 * the semantic limit the model meets.
 */
export const FALLBACK_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;

/**
 * Upper bound on the raw stdout the fallback buffers, base64 framing
 * included: roughly 4/3 of `FALLBACK_MAX_PLAINTEXT_BYTES` plus markers, with
 * headroom, so the framing check fails before the memory cap matters.
 */
export const FALLBACK_MAX_STDOUT_BYTES = 48 * 1024 * 1024;

/** How many fallback PowerShell processes may run at once; excess calls queue. */
export const FALLBACK_MAX_CONCURRENCY = 2;

/**
 * The NUL-scan window `readText`/`streamText` apply to fallback plaintext,
 * mirroring dsh-fs-local's `BINARY_SAMPLE_BYTES` so a decrypted binary is
 * rejected exactly where the unencrypted original would be.
 */
export const BINARY_SAMPLE_BYTES = 8192;

/** Environment variable the file path travels in; never interpolated into the script. */
export const FALLBACK_PATH_ENV = 'AICLIENT_FS_PATH';

/** stdout framing markers around the base64 payload (decision 091: adopted after probing). */
export const FRAME_BEGIN = 'AICLIENT-FS-B64-BEGIN';
export const FRAME_END = 'AICLIENT-FS-B64-END';

/** The fixed PowerShell 5.1 command line; no PATH lookup, no pwsh 7. */
export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive'] as const;

/** Absolute powershell.exe path from `%SystemRoot%`; null when the variable is absent. */
export function powershellExePath(env: Record<string, string | undefined>): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return typeof root === 'string' && root.length > 0
    ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : null;
}

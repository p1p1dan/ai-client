/**
 * Pure decision logic for the packaged Codex smoke (packaging spec §6.2).
 *
 * Split out of verify-packaged-app.mjs for the same reason as the build lib:
 * the verifier is a self-executing CLI, so nothing inside it can be unit
 * tested. Everything here is pure — no IO, no process reads, no spawning.
 */

/**
 * S2 exit verdict. "The process ended" is NOT the same as "the process ended
 * cleanly": a `close` event fires for exit code 7 and for SIGKILL just as it
 * does for a clean exit, so a listener that ignores both arguments turns the
 * spec §6.2 "干净退出" assertion into a tautology (it would then only prove
 * that close fired at all).
 *
 * @param {{code: number|null, signal: string|null}} exit
 * @returns {boolean} true only for exit status 0 with no terminating signal
 */
export function isCleanExit({ code, signal }) {
  return code === 0 && (signal === null || signal === undefined);
}

/** Human-readable exit status for logs and failure details. */
export function describeExit({ code, signal }) {
  if (signal) return `signal ${signal}`;
  if (code === null || code === undefined) return 'no exit status';
  return `code ${code}`;
}

/**
 * Path equality for the S2 `codexHome` echo.
 *
 * Raw `===` is wrong on Windows: `os.tmpdir()` on a GitHub runner hands back the
 * 8.3 short form (`C:\\Users\\RUNNER~1\\AppData\\Local\\Temp`) while codex reports the
 * resolved long form, so the same directory compares unequal — the caller
 * therefore canonicalises with `fs.realpathSync.native` before calling this, and
 * this handles the remaining difference: Windows paths are case-insensitive.
 * Same hazard the spec flags for NodeRuntimeResolver.pathsEqual (§10.3-B12).
 *
 * `platform` is injected so a Linux test box can exercise the win32 arm.
 */
export function samePathText(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T066 回炉 — the one near-hot log point the threshold change promoted.
 *
 * The `local-image` protocol handler writes two lines per rendered image, each
 * an unredacted absolute file path. Both were `console.log`, i.e. `info` once
 * `initLogger` hijacks the console — harmless while the file transport sat at
 * `error`, and a per-thumbnail record of the user's directory layout once it
 * moved to `info`.
 *
 * A static scan rather than a behavioural case: the handler is registered
 * inside `app.whenReady()` against Electron's `protocol` module, so nothing
 * short of a real app run reaches it, and the property that matters here — the
 * LEVEL these two lines are written at — is readable from the source.
 */
describe('the local-image handler’s per-image lines', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf-8');

  it('logs the request URL and the parsed path below the file threshold', () => {
    expect(source).toContain('console.debug(`[local-image] Request URL:');
    expect(source).toContain('console.debug(`[local-image] Parsed Path:');
  });

  it('writes no [local-image] path line at a level that reaches the log file', () => {
    // `log`/`info`/`warn`/`error` all sit at or above `DISABLED_FILE_LEVEL`.
    const reachesDisk =
      /console\.(log|info|warn|error)\(`\[local-image\] (Request URL|Parsed Path)/;
    expect(source).not.toMatch(reachesDisk);
  });
});

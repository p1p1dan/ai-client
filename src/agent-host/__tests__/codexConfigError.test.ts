import { describe, expect, it } from 'vitest';
import {
  classifyCodexConfigLoadFailure,
  describeCodexConfigLoadFailure,
} from '../codexConfigError.ts';

/**
 * S0'-b. Every input below is a message this build's codex (0.149.1) actually
 * produced during E2's D-group probes — copied verbatim, not paraphrased. That
 * is the point of the file: the parser exists to read codex's wording, so a
 * test written against invented wording would prove nothing.
 */
describe('codex config-load failure', () => {
  // ── verbatim from E2 D2 / D6 / D7 ─────────────────────────────────────────
  const SYNTAX =
    'failed to load configuration: /home/u/.codex/config.toml:2:10: extra `=`, expected nothing';
  const SYNTAX_2 =
    'failed to load configuration: /home/u/.codex/config.toml:1:6: key with no value, expected `=`';
  const LEGACY_PROFILE =
    'failed to load configuration: legacy `profile = "userprof"` config is no longer supported; use `--profile userprof` with `userprof.config.toml` instead';

  describe('classify', () => {
    it('reads path, line and column out of a syntax error', () => {
      expect(classifyCodexConfigLoadFailure(SYNTAX)).toEqual({
        kind: 'syntax_error',
        file: '/home/u/.codex/config.toml',
        line: 2,
        column: 10,
        profileName: null,
        detail: '/home/u/.codex/config.toml:2:10: extra `=`, expected nothing',
      });
    });

    it('reads the second measured syntax error too', () => {
      const out = classifyCodexConfigLoadFailure(SYNTAX_2);
      expect(out?.kind).toBe('syntax_error');
      expect(out?.line).toBe(1);
      expect(out?.column).toBe(6);
    });

    it('reads the profile name out of the legacy-profile error, which carries no path', () => {
      expect(classifyCodexConfigLoadFailure(LEGACY_PROFILE)).toEqual({
        kind: 'legacy_profile',
        file: null,
        line: null,
        column: null,
        profileName: 'userprof',
        detail:
          'legacy `profile = "userprof"` config is no longer supported; use `--profile userprof` with `userprof.config.toml` instead',
      });
    });

    /**
     * The `configWarning` notification carries the same text WITHOUT the
     * `failed to load configuration:` prefix — codex pushes it right after
     * `initialize`, before it rejects `thread/start` [实测 E2 D 组].
     */
    it('accepts the prefix-less form the configWarning notification carries', () => {
      const out = classifyCodexConfigLoadFailure(
        '/home/u/.codex/config.toml:2:10: extra `=`, expected nothing'
      );
      expect(out?.kind).toBe('syntax_error');
      expect(out?.file).toBe('/home/u/.codex/config.toml');
    });

    /**
     * A Windows path has a colon of its own. Matching from the left would read
     * the drive letter as the line number and report `line C`.
     */
    it('does not mistake a Windows drive letter for a line number', () => {
      const out = classifyCodexConfigLoadFailure(
        'failed to load configuration: C:\\Users\\u\\.codex\\config.toml:7:3: unexpected token'
      );
      expect(out).toMatchObject({
        kind: 'syntax_error',
        file: 'C:\\Users\\u\\.codex\\config.toml',
        line: 7,
        column: 3,
      });
    });

    /**
     * When the message carries more than one `:<line>:<column>: `, the FIRST is
     * the file that failed to load; a later one belongs to the reason text.
     * Taking the last would name the wrong file with the wrong line — worse
     * than saying nothing, because the user would go and edit a good file.
     */
    it('takes the FIRST location when the reason quotes one of its own', () => {
      const out = classifyCodexConfigLoadFailure(
        'failed to load configuration: /home/u/.codex/config.toml:2:10: while reading /home/u/.codex/other.toml:9:1: bad value'
      );
      expect(out?.file).toBe('/home/u/.codex/config.toml');
      expect(out?.line).toBe(2);
      expect(out?.column).toBe(10);
    });

    it('keeps a reason that contains its own colons intact', () => {
      const out = classifyCodexConfigLoadFailure(
        'failed to load configuration: /home/u/.codex/config.toml:3:1: bad value: expected one of: a, b'
      );
      expect(out?.line).toBe(3);
      expect(out?.detail).toBe('/home/u/.codex/config.toml:3:1: bad value: expected one of: a, b');
    });

    it('falls back to `unknown` for a config failure whose shape it does not know', () => {
      const out = classifyCodexConfigLoadFailure(
        'failed to load configuration: something nobody has seen yet'
      );
      expect(out).toMatchObject({ kind: 'unknown', file: null, line: null });
    });

    /**
     * The load-bearing negative. An unrelated failure dressed in config-shaped
     * wording would send the user to edit a file that is fine.
     */
    it('returns null for anything that is not a config-load failure', () => {
      for (const other of [
        'Missing environment variable: AICLIENT_CODEX_API_KEY.',
        'Reconnecting... waiting for network',
        'thread/start returned no thread id',
        '/home/u/.codex/config.toml',
        '',
        null,
        undefined,
        42,
        { message: 'failed to load configuration: x' },
      ]) {
        expect(classifyCodexConfigLoadFailure(other)).toBeNull();
      }
    });
  });

  describe('describe', () => {
    it('names the file, the line, and what to correct', () => {
      const text = describeCodexConfigLoadFailure(
        classifyCodexConfigLoadFailure(SYNTAX) as never,
        '/home/u/.codex'
      );
      expect(text).toContain('/home/u/.codex/config.toml');
      expect(text).toContain('line 2');
      expect(text).toContain('column 10');
      expect(text).toContain('extra `=`, expected nothing');
    });

    /**
     * The legacy-profile message carries no path, so the file has to be named
     * from codex's `initialize` echo. Without it the user is told to fix a file
     * we never identified.
     */
    it('names the file from the codexHome echo when the message carried none', () => {
      const text = describeCodexConfigLoadFailure(
        classifyCodexConfigLoadFailure(LEGACY_PROFILE) as never,
        '/home/u/.codex'
      );
      expect(text).toContain('/home/u/.codex/config.toml');
      expect(text).toContain('profile = "userprof"');
      expect(text).toContain('userprof.config.toml');
    });

    /**
     * The symptom that makes this failure look like OUR bug: the user's own
     * `codex` may be an older build that still accepts the line. Saying so is
     * the difference between an actionable message and a support ticket.
     */
    it('says why their own terminal codex may still work', () => {
      const text = describeCodexConfigLoadFailure(
        classifyCodexConfigLoadFailure(LEGACY_PROFILE) as never,
        '/home/u/.codex'
      );
      expect(text.toLowerCase()).toContain('older');
      expect(text.toLowerCase()).toContain('path');
    });

    it('degrades without inventing a path when codex echoed no home', () => {
      const text = describeCodexConfigLoadFailure(
        classifyCodexConfigLoadFailure(LEGACY_PROFILE) as never,
        null
      );
      expect(text).toContain('your codex config.toml');
      expect(text).not.toContain('undefined');
      expect(text).not.toMatch(/\/null\//);
    });

    it('quotes codex verbatim rather than rewording it', () => {
      const detail = 'something nobody has seen yet';
      const text = describeCodexConfigLoadFailure(
        classifyCodexConfigLoadFailure(`failed to load configuration: ${detail}`) as never,
        '/home/u/.codex'
      );
      expect(text).toContain(detail);
    });
  });
});

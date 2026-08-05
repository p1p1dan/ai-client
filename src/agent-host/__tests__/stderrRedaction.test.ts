import { describe, expect, it } from 'vitest';
import { redactStderrLine, STDERR_LINE_MAX_CHARS, sanitizeStderrLine } from '../stderrRedaction.ts';

/**
 * T-35 acceptance ②: the redaction rule set, pinned per category — ANTHROPIC_*
 * values, token-shaped strings, auth headers, user-directory paths — plus the
 * two reverse guarantees that make the feature worth shipping: diagnostic
 * content (session ids, non-user paths, error text) passes through untouched.
 */

describe('redactStderrLine — credentials', () => {
  it('masks the value of any ANTHROPIC_* assignment while keeping the variable name', () => {
    expect(redactStderrLine('ANTHROPIC_AUTH_TOKEN=super-secret-value')).toBe(
      'ANTHROPIC_AUTH_TOKEN=[redacted]'
    );
    expect(redactStderrLine('ANTHROPIC_API_KEY: "secretvalue"')).toBe(
      'ANTHROPIC_API_KEY: "[redacted]"'
    );
    expect(redactStderrLine('env ANTHROPIC_BASE_URL=https://gw.internal/v1 rejected')).toBe(
      'env ANTHROPIC_BASE_URL=[redacted] rejected'
    );
  });

  it('destroys sk-ant key material wherever it appears', () => {
    expect(redactStderrLine('401 for key sk-ant-api03-AbC_dEf-123')).toBe('401 for key [redacted]');
  });

  it('masks HTTP auth header values', () => {
    expect(redactStderrLine('authorization: Bearer eyJhbGciOi.payload.sig')).toBe(
      'authorization: Bearer [redacted]'
    );
    expect(redactStderrLine('X-Api-Key: live-key-123')).toBe('X-Api-Key: [redacted]');
  });

  it('destroys a credential inside a path rather than merely relocating it', () => {
    expect(redactStderrLine('read /home/dan/.keys/sk-ant-xyz failed')).toBe(
      'read ~/.keys/[redacted] failed'
    );
  });
});

describe('redactStderrLine — user-directory paths', () => {
  it('collapses the user-directory prefix to ~ on all three OS shapes, keeping the tail', () => {
    expect(redactStderrLine('ENOENT: /home/dan/projects/app/cli.js')).toBe(
      'ENOENT: ~/projects/app/cli.js'
    );
    expect(redactStderrLine('config at /Users/alice/.claude/settings.json')).toBe(
      'config at ~/.claude/settings.json'
    );
    expect(redactStderrLine('spawn C:\\Users\\Alice\\AppData\\claude.exe failed')).toBe(
      'spawn ~\\AppData\\claude.exe failed'
    );
  });

  it('leaves non-user absolute paths alone — they reveal nothing personal and carry the diagnosis', () => {
    const line = 'module not found: /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    expect(redactStderrLine(line)).toBe(line);
  });
});

describe('redactStderrLine — diagnostic value survives', () => {
  it('passes the canonical useful stderr line through untouched, session id included', () => {
    const line = 'No conversation found with session ID: 0199a1b2-c3d4-7890-abcd-ef0123456789';
    expect(redactStderrLine(line)).toBe(line);
  });

  it('leaves a variable name without an assigned value alone', () => {
    const line = 'ANTHROPIC_AUTH_TOKEN is not set';
    expect(redactStderrLine(line)).toBe(line);
  });
});

describe('sanitizeStderrLine', () => {
  it('clamps a pathological line to the IPC cap with a visible ellipsis', () => {
    const long = 'x'.repeat(STDERR_LINE_MAX_CHARS + 500);
    const out = sanitizeStderrLine(long);
    expect(out).toHaveLength(STDERR_LINE_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a short line untouched and redacts before clamping', () => {
    expect(sanitizeStderrLine('plain diagnostic')).toBe('plain diagnostic');
    const secretTail = `${'x'.repeat(STDERR_LINE_MAX_CHARS - 10)} sk-ant-secret-material-goes-here`;
    expect(sanitizeStderrLine(secretTail)).not.toContain('sk-ant');
  });
});

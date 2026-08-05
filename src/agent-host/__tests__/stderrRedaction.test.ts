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

describe('redactStderrLine — adversarial matrix (Codex review F2–F4)', () => {
  it('masks non-Anthropic provider keys and generic sensitive assignments', () => {
    expect(redactStderrLine('OPENAI_API_KEY=sk-proj-abc123def456ghi789')).toBe(
      'OPENAI_API_KEY=[redacted]'
    );
    expect(redactStderrLine('OPENAI_API_KEY="sk-abc123"')).toBe('OPENAI_API_KEY="[redacted]"');
    expect(redactStderrLine('api_key=provider-secret')).toBe('api_key=[redacted]');
    expect(redactStderrLine('refresh_token: rt-12345 expired')).toBe(
      'refresh_token: [redacted] expired'
    );
  });

  it('destroys Basic blobs whole and matches auth schemes case-insensitively', () => {
    expect(redactStderrLine('Authorization: Basic dXNlcjpzZWNyZXQ=')).toBe(
      'Authorization: Basic [redacted]'
    );
    const lower = redactStderrLine('authorization: bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    expect(lower).toBe('authorization: bearer [redacted]');
    expect(redactStderrLine('Authorization: BEARER opaque-access-token')).toBe(
      'Authorization: BEARER [redacted]'
    );
  });

  it('handles JSON-quoted names and quoted values containing spaces (whole value dies)', () => {
    expect(redactStderrLine('{"ANTHROPIC_API_KEY":"plain-secret-value"}')).toBe(
      '{"ANTHROPIC_API_KEY":"[redacted]"}'
    );
    expect(redactStderrLine('ANTHROPIC_AUTH_TOKEN="super secret value"')).toBe(
      'ANTHROPIC_AUTH_TOKEN="[redacted]"'
    );
  });

  it('masks URL authority userinfo, keeping scheme and host', () => {
    expect(
      redactStderrLine('request failed: https://alice:secret-password@gateway.example.com/v1')
    ).toBe('request failed: https://[redacted]@gateway.example.com/v1');
    expect(redactStderrLine('proxy error: http://build-user:p%40ssword@proxy.internal:8080/')).toBe(
      'proxy error: http://[redacted]@proxy.internal:8080/'
    );
    expect(redactStderrLine('token-as-user: https://tok123@host/ and https://a:b@h2/')).toBe(
      'token-as-user: https://[redacted]@host/ and https://[redacted]@h2/'
    );
  });

  it('masks bare provider key shapes with no field name to hook (round 2: Stripe/GitHub/Google/AWS/sk-proj)', () => {
    expect(redactStderrLine('Stripe sk_live_1234567890abcdef')).toBe('Stripe [redacted]');
    expect(redactStderrLine('Google AIzaSyA1234567890abcdef')).toBe('Google [redacted]');
    expect(redactStderrLine('GitHub ghp_1234567890abcdef')).toBe('GitHub [redacted]');
    expect(redactStderrLine('AWS AKIAIOSFODNN7EXAMPLE')).toBe('AWS [redacted]');
    expect(redactStderrLine('AWS STS ASIAIOSFODNN7EXAMPLE')).toBe('AWS STS [redacted]');
    expect(redactStderrLine('bare OpenAI-ish sk-proj-abc123')).toBe('bare OpenAI-ish [redacted]');
  });

  it('does not eat ordinary diagnostic vocabulary near the sensitive-name rules', () => {
    for (const line of [
      'input_tokens: 4096 output_tokens: 512',
      'token count exceeded for this turn',
      'max_tokens: 32000',
    ]) {
      expect(redactStderrLine(line)).toBe(line);
    }
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

  it('covers the Windows/UNC/WSL variants a Windows-side CLI actually prints (review F5)', () => {
    expect(redactStderrLine('C:/Users/Alice/AppData/Roaming/Claude/config.json')).toBe(
      '~/AppData/Roaming/Claude/config.json'
    );
    expect(redactStderrLine('\\\\SERVER\\Users\\Alice\\.claude\\settings.json')).toBe(
      '~\\.claude\\settings.json'
    );
    expect(redactStderrLine('\\\\wsl.localhost\\Ubuntu\\home\\alice\\.claude\\settings.json')).toBe(
      '~\\.claude\\settings.json'
    );
    expect(redactStderrLine('/mnt/c/Users/Alice/.claude/settings.json')).toBe(
      '~/.claude/settings.json'
    );
  });

  it('handles Windows usernames with spaces and apostrophes when a separator follows (round 2)', () => {
    expect(redactStderrLine('C:\\Users\\Alice Smith\\AppData\\x')).toBe('~\\AppData\\x');
    expect(redactStderrLine("C:\\Users\\O'Neil\\x")).toBe('~\\x');
    expect(redactStderrLine('\\\\SERVER\\Users\\Alice Smith\\x')).toBe('~\\x');
    expect(redactStderrLine('/mnt/c/Users/Alice Smith/.claude/settings.json')).toBe(
      '~/.claude/settings.json'
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

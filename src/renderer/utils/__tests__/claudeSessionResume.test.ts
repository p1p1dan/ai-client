import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveClaudeConfigDirForSession } from '../claudeSessionResume';

describe('resolveClaudeConfigDirForSession', () => {
  const existsMock = vi.fn();

  function stubWindow(overrides: { HOME?: string; platform?: string } = {}) {
    vi.stubGlobal('window', {
      electronAPI: {
        env: {
          HOME: overrides.HOME ?? '/Users/pi',
          platform: overrides.platform ?? 'linux',
        },
        file: {
          exists: existsMock,
        },
      },
    });
  }

  beforeEach(() => {
    existsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the dry-run claude-null config dir when the session lives there', async () => {
    stubWindow();
    existsMock.mockImplementation(async (path: string) => path.includes('claude-null'));

    const result = await resolveClaudeConfigDirForSession('proj-1', 'session-1');

    expect(result.configDir).toBe('/Users/pi/.aiclient/claude-null');
    expect(result.diagnostic).toBe('');
  });

  it('returns the real ~/.claude config dir when the session lives there', async () => {
    stubWindow();
    existsMock.mockImplementation(async (path: string) => path.startsWith('/Users/pi/.claude/'));

    const result = await resolveClaudeConfigDirForSession('proj-1', 'session-1');

    expect(result.configDir).toBe('/Users/pi/.claude');
    expect(result.diagnostic).toBe('');
  });

  it('returns null with a diagnostic listing both checked paths when neither exists', async () => {
    stubWindow();
    existsMock.mockResolvedValue(false);

    const result = await resolveClaudeConfigDirForSession('proj-1', 'session-1');

    expect(result.configDir).toBeNull();
    expect(result.diagnostic).toContain(
      '/Users/pi/.aiclient/claude-null/projects/proj-1/session-1.jsonl'
    );
    expect(result.diagnostic).toContain('/Users/pi/.claude/projects/proj-1/session-1.jsonl');
  });

  it('returns null with a HOME-missing diagnostic when HOME is unavailable, without probing the filesystem', async () => {
    stubWindow({ HOME: '' });

    const result = await resolveClaudeConfigDirForSession('proj-1', 'session-1');

    expect(result.configDir).toBeNull();
    expect(result.diagnostic).toContain('HOME');
    expect(existsMock).not.toHaveBeenCalled();
  });

  it('uses backslash separators on Windows', async () => {
    stubWindow({ HOME: 'C:\\Users\\pi', platform: 'win32' });
    existsMock.mockImplementation(async (path: string) => path.includes('claude-null'));

    const result = await resolveClaudeConfigDirForSession('proj-1', 'session-1');

    expect(result.configDir).toBe('C:\\Users\\pi\\.aiclient\\claude-null');
    expect(existsMock).toHaveBeenCalledWith(
      'C:\\Users\\pi\\.aiclient\\claude-null\\projects\\proj-1\\session-1.jsonl'
    );
  });
});

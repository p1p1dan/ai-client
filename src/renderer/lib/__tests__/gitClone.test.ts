import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateClonePath, getDefaultBaseDir } from '../gitClone';

describe('gitClone', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        env: {
          HOME: '/Users/pi',
          platform: 'linux',
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses JYWAI as the default clone base directory', () => {
    expect(getDefaultBaseDir()).toBe('/Users/pi/JYWAI/repos');
  });

  it('expands home-relative clone base directories before generating paths', () => {
    const result = generateClonePath(
      'https://github.com/openai/codex.git',
      '~/JYWAI/repos',
      [{ dirname: 'github', pattern: 'github.com' }],
      true
    );

    expect(result.targetDir).toBe('/Users/pi/JYWAI/repos/github/openai');
    expect(result.repoName).toBe('codex');
    expect(result.fullPath).toBe('/Users/pi/JYWAI/repos/github/openai/codex');
  });
});

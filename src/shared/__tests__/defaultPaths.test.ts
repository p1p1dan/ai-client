import { describe, expect, it } from 'vitest';
import {
  buildWorktreePath,
  expandHomePath,
  getDefaultCloneBaseDir,
  getDefaultTemporaryBasePath,
  getDefaultWorktreeBasePath,
} from '../defaultPaths';

describe('defaultPaths', () => {
  it('uses JYWAI directories for default base paths', () => {
    expect(getDefaultTemporaryBasePath('/Users/pi', '/')).toBe('/Users/pi/JYWAI/temporary');
    expect(getDefaultWorktreeBasePath('/Users/pi', '/')).toBe('/Users/pi/JYWAI/workspaces');
    expect(getDefaultCloneBaseDir('/Users/pi', '/')).toBe('/Users/pi/JYWAI/repos');
  });

  it('expands tilde-prefixed paths against the current home directory', () => {
    expect(expandHomePath('~/JYWAI/repos', '/Users/pi', '/')).toBe('/Users/pi/JYWAI/repos');
    expect(expandHomePath('~\\JYWAI\\workspaces', 'C:\\Users\\pi', '\\')).toBe(
      'C:\\Users\\pi\\JYWAI\\workspaces'
    );
  });

  it('builds worktree paths from configured home-relative base paths', () => {
    expect(
      buildWorktreePath({
        branchName: 'feature-login',
        configuredBasePath: '~/JYWAI/workspaces',
        homeDir: '/Users/pi',
        pathSep: '/',
        projectName: '/repos/jyw-ai-client',
      })
    ).toBe('/Users/pi/JYWAI/workspaces/jyw-ai-client/feature-login');
  });
});

import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { catalogOptions } from '../catalog.ts';

/**
 * dsh-rebase decision 194 Q1: the CLI a catalog host starts lists a folder the way a chat
 * there would see it, and runs none of its hooks (measured on 2.1.300: starting the CLI
 * runs SessionStart hooks even with no message).
 */

const base = {
  configDir: '/app/claude',
  settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
  cliEnv: { CLAUDE_CONFIG_DIR: '/app/claude' },
  timeoutMs: 1_000,
};

describe('catalogOptions', () => {
  it('turns every hook off, and reads a trusted project as its chat would', () => {
    const cwd = tmpdir();
    const options = catalogOptions({ ...base, cwd, projectTrusted: true, cliPath: '/bin/claude' });
    expect(options.settings).toMatchObject({ disableAllHooks: true, attribution: false });
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect((options as { workspaceTrust?: unknown }).workspaceTrust).toEqual({
      accepted: true,
      directory: cwd,
    });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.pathToClaudeCodeExecutable).toBe('/bin/claude');
    expect(options.env).toBe(base.cliEnv);
  });

  it('with no project, or the home directory, reads the user layer alone', () => {
    for (const cwd of [base.configDir, homedir()]) {
      const options = catalogOptions({ ...base, cwd, projectTrusted: cwd === homedir() });
      expect(options.settingSources).toEqual(['user']);
      expect((options as { workspaceTrust?: unknown }).workspaceTrust).toBeUndefined();
      expect(options.settings).toMatchObject({ disableAllHooks: true });
    }
  });
});

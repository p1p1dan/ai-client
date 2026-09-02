import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('T36 Pi-only terminal and CLI absence gate', () => {
  it('removes active legacy agent picker, detector, installer and sharing entry points', () => {
    for (const path of [
      'src/main/ipc/agent.ts',
      'src/main/ipc/hapi.ts',
      'src/main/services/agent/AgentRegistry.ts',
      'src/main/services/cli/CliDetector.ts',
      'src/shared/types/cli.ts',
      'src/renderer/components/chat/AgentPickerMenu.tsx',
      'src/renderer/components/settings/AgentSettings.tsx',
      'src/renderer/components/settings/HapiSettings.tsx',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
  });

  it('does not expose legacy CLI or remote-sharing IPC', () => {
    const contracts = `${read('src/shared/types/ipc.ts')}\n${read('src/preload/index.ts')}`;
    for (const token of [
      'CLI_DETECT_ONE',
      'AGENT_LIST',
      'ONBOARDING_INSTALL_AGENTS',
      'HAPI_START',
      'HAPPY_CHECK_GLOBAL',
      'CLOUDFLARED_START',
      'onAgentStop',
    ]) {
      expect(contracts, token).not.toContain(token);
    }
  });

  it('remote helper cannot execute legacy agent or plugin CLI methods', () => {
    const helper = read('src/main/services/remote/RemoteHelperSource.ts');
    for (const token of [
      "command: 'claude'",
      "command: 'codex'",
      "'cli:detectOne'",
      "'claude:plugins:",
      "'hapi:checkGlobal'",
      "'happy:checkGlobal'",
    ]) {
      expect(helper, token).not.toContain(token);
    }
  });

  it('generic shell sessions reject the retired agent PTY route', () => {
    const manager = read('src/main/services/session/SessionManager.ts');
    expect(manager).toContain("if (options.kind === 'agent')");
    expect(manager).toContain('Agent PTYs must use the dedicated Pi TUI API');
    expect(manager).not.toContain('withManagedClaudeEnv');
    expect(manager).not.toContain('withManagedPiEnv');
  });

  it('uses absolute bundled Pi CLI and packaged Node paths without resume flags', () => {
    const service = read('src/main/services/terminal/PiTuiPty.ts');
    expect(service).toContain("'pi-coding-agent'");
    expect(service).toContain("'node-runtime'");
    expect(service).toContain('args: [cliPath]');
    expect(service).not.toContain("'--session'");
    expect(service).not.toContain("'--continue'");
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('T35 final Pi-only absence gate', () => {
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
      'src/renderer/components/chat/StatusLine.tsx',
      'src/renderer/stores/agentStatus.ts',
      'src/renderer/hooks/useManagedMode.ts',
      'src/main/services/auth/claudeHome.ts',
      'src/main/services/auth/__tests__/managedFileWriter.test.ts',
      'src/shared/types/claude.ts',
      'src/shared/types/claudeRuntime.ts',
      'packages/bootstrap/cmd/jyw-bootstrap/main.go',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
  });

  it('does not expose legacy CLI or remote-sharing IPC', () => {
    const contracts = `${read('src/shared/types/ipc.ts')}\n${read('src/preload/index.ts')}\n${read(
      'src/main/ipc/auth.ts'
    )}\n${read('src/main/services/onboarding/OnboardingService.ts')}`;
    for (const token of [
      'CLI_DETECT_ONE',
      'REMOTE_HELPER_',
      'AGENT_LIST',
      'ONBOARDING_INSTALL_AGENTS',
      'HAPI_START',
      'HAPPY_CHECK_GLOBAL',
      'CLOUDFLARED_START',
      'onAgentStop',
      'AUTH_MANAGED_MODE',
      'AGENT_STATUS_UPDATE',
      'AGENT_ASK_USER_QUESTION_NOTIFICATION',
      'AGENT_PRE_TOOL_USE_NOTIFICATION',
      'checkCredentialsHealth',
      'claudeEnvOk',
      'codexAuthOk',
    ]) {
      expect(contracts, token).not.toContain(token);
    }
  });

  it('remote helper cannot execute legacy agent or plugin CLI methods', () => {
    const helper = read('src/main/services/remote/RemoteServerSource.ts');
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

  it('removes legacy permission runtime contracts and renderer projections', () => {
    const contracts = `${read('src/shared/types/runtimeEvents.ts')}\n${read(
      'src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts'
    )}\n${read('src/shared/types/onboarding.ts')}\n${read('src/main/ipc/auth.ts')}`;
    for (const token of [
      'SessionPermissionPreference',
      'SessionPermissionPolicy',
      'session.permissionUpdated',
      'session.settingsEcho',
      "agent: 'claude-code'",
      "agent: 'codex'",
    ]) {
      expect(contracts, token).not.toContain(token);
    }
  });

  it('keeps active onboarding and runtime failure copy Pi-only', () => {
    const productCopy = `${read('src/renderer/Root.tsx')}\n${read(
      'src/renderer/components/onboarding/WelcomeView.tsx'
    )}\n${read('src/renderer/components/onboarding/OnboardingView.tsx')}`;
    for (const token of ['Claude Code 运行时', 'Claude Code 与 Codex', 'bundled Claude Code']) {
      expect(productCopy, token).not.toContain(token);
    }
    expect(productCopy).toContain('无法检测 Pi 运行时');
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

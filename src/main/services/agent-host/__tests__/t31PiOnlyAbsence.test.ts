import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const at = (...parts: string[]) => path.join(repoRoot, ...parts);

const deletedRuntimeFiles = [
  'src/agent-host/claudeRuntime.ts',
  'src/agent-host/eventNormalizer.ts',
  'src/agent-host/codexRuntime.ts',
  'src/agent-host/codexConnection.ts',
  'src/agent-host/codexNormalizer.ts',
  'src/agent-host/sessionRegistry.ts',
  'src/agent-host/permissionBridge.ts',
  'src/agent-host/questionBridge.ts',
  'src/agent-host/ttftWatchdog.ts',
  'src/renderer/components/chat/ComposerAgentPicker.tsx',
  // `ComposerPermissionTrigger.tsx` was on this list until U12 gave that name
  // to a Pi-native control (the session permission tier chip). The legacy
  // permission surface this gate is really about is pinned by channel below,
  // which is the check that cannot be satisfied by a coincidence of filename.
  'src/renderer/components/chat/PendingQuestionDock.tsx',
  'src/shared/models/familyWhitelist.ts',
  'src/shared/models/seedCatalog.ts',
  'src/main/ipc/claudeRuntime.ts',
  'src/main/services/cli/ClaudeRuntimeChecker.ts',
] as const;

describe('T31 Pi-only absence gate', () => {
  it('contains no replaced live Claude/Codex producer or picker file', () => {
    for (const relative of deletedRuntimeFiles) {
      expect(existsSync(at(relative)), relative).toBe(false);
    }
  });

  it('keeps only Pi worker runtime dependencies in the utility package', () => {
    const manifest = JSON.parse(readFileSync(at('src/agent-host/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    expect(all['@earendil-works/pi-coding-agent']).toBeTruthy();
    expect(all['@gotgenes/pi-permission-system']).toBeTruthy();
    expect(all['@anthropic-ai/claude-agent-sdk']).toBeUndefined();
    expect(all['@cometix/claude-code']).toBeUndefined();
    expect(all['@openai/codex']).toBeUndefined();
    const rootManifest = JSON.parse(readFileSync(at('package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(rootManifest.dependencies?.['@agentclientprotocol/sdk']).toBeUndefined();
  });

  it('exposes only Pi model and portable Extension UI execution channels', () => {
    const ipc = readFileSync(at('src/shared/types/ipc.ts'), 'utf8');
    const preload = readFileSync(at('src/preload/index.ts'), 'utf8');
    const chat = readFileSync(at('src/main/ipc/chat.ts'), 'utf8');
    const composer = readFileSync(at('src/renderer/components/chat/ChatComposer.tsx'), 'utf8');

    expect(ipc).toContain("PI_RUNTIME_CHECK: 'pi:runtime:check'");
    expect(ipc).toContain("CHAT_LIST_PI_MODELS: 'chat:listPiModels'");
    expect(ipc).toContain("CHAT_RESPOND_EXTENSION_UI: 'chat:respondExtensionUi'");
    for (const legacy of [
      'CLAUDE_RUNTIME_CHECK',
      'CHAT_LIST_AGENT_MODELS',
      'CHAT_UPDATE_PERMISSION',
      'CHAT_RESPOND_PERMISSION',
      'CHAT_RESPOND_QUESTION',
    ]) {
      expect(ipc, legacy).not.toContain(legacy);
    }
    expect(preload).toContain('listPiModels:');
    expect(preload).not.toContain('listAgentModels:');
    expect(chat).not.toContain('assertModelMatchesAgent');
    expect(composer).not.toContain('ComposerAgentPicker');
    for (const legacy of ['chat:respondPermission', 'chat:updatePermission', 'permissionMode']) {
      expect(composer, legacy).not.toContain(legacy);
    }
  });

  it('preserves migration-only readers without giving them an execution import', () => {
    for (const relative of [
      'src/main/services/legacyImport/ClaudeSessionScanner.ts',
      'src/main/services/legacyImport/ClaudeSourceAdapter.ts',
      'src/agent-host/codexHistoryReader.ts',
      'src/agent-host/codexItemMapper.ts',
    ]) {
      const source = readFileSync(at(relative), 'utf8');
      for (const forbidden of [
        './claudeRuntime',
        './codexRuntime',
        './codexConnection',
        './codexNodeEntry',
        './cometix',
      ]) {
        expect(source, `${relative} -> ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

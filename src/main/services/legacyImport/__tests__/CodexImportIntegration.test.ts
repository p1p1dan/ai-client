import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PiSdkModule } from '../../../../agent-host/piAgentSessionBootstrap.ts';
import { PiLegacyImportWriter } from '../../../../agent-host/piLegacyImport.ts';
import { CodexSessionScanner } from '../CodexSessionScanner';
import { CodexSourceAdapter } from '../CodexSourceAdapter';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Codex rollout to native Pi integration', () => {
  it('converts captured disk history, publishes Pi history and reopens it without executable legacy tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pi-integration-'));
    roots.push(root);
    const sources = join(root, 'sources');
    await mkdir(sources);
    const sourceFile = join(sources, 'rollout.jsonl');
    await copyFile(
      resolve(
        __dirname,
        '../../../../agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl'
      ),
      sourceFile
    );
    const original = await readFile(sourceFile);
    const scanner = new CodexSessionScanner(() => sources);
    const [summary] = await scanner.scan();
    const adapter = new CodexSourceAdapter(scanner);
    const converted = await adapter.read({
      sourceKind: 'codex',
      projectId: summary.projectId,
      sourceSessionId: summary.sessionId,
    });
    // Pin to the worker package, not the root checkout's potentially newer SDK.
    const real = await import(
      '../../../../agent-host/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    );
    const sdk = {
      SessionManager: {
        create: (
          cwd: string,
          sessionDir?: string,
          options?: { id?: string; parentSession?: string }
        ) => real.SessionManager.create(cwd, sessionDir ?? join(root, 'target'), options),
        open: (file: string) => real.SessionManager.open(file),
      },
    } as unknown as PiSdkModule;
    const writer = new PiLegacyImportWriter(async () => sdk);
    const imported = await writer.create({
      logicalSessionId: 'logical-codex-probe',
      targetPiSessionId: 'import-codex-probe',
      conversation: converted.conversation,
    });
    await adapter.assertUnchanged(sourceFile, converted.conversation.sourceFingerprint);
    expect(await readFile(sourceFile)).toEqual(original);
    const reopened = real.SessionManager.open(imported.finalSessionFile);
    const context = reopened.buildSessionContext();
    expect(context.messages.some((message) => message.role === 'user')).toBe(true);
    expect(context.messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(JSON.stringify(context.messages)).not.toContain('fixture_tool');
    expect(JSON.stringify(context.messages)).not.toContain('encrypted_content');
    const disk = await readFile(imported.finalSessionFile, 'utf8');
    expect(disk).toContain('fixture_tool');
    expect(disk).toContain('"sourceKind":"codex"');
    expect(imported.history.page.messages.some((message) => message.role === 'system')).toBe(true);
    expect(
      await writer.reconcileInterrupted(converted.conversation.workspacePath, 'import-codex-probe')
    ).toEqual({ removedFiles: 1, remainingFiles: 0 });
  }, 20_000);
});

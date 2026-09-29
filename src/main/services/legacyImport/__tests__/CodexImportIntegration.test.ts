import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionScanner } from '../CodexSessionScanner';
import { CodexSourceAdapter } from '../CodexSourceAdapter';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Codex 磁盘记录 → 可导入的对话，端到端一次。
 *
 * P6-5 之前这个用例还把转写结果交给 `PiLegacyImportWriter` 写成会话文件再读回来。
 * 那个写入方随旧引擎一起删了。**写入这一半自 P1-9f（决策 056）起归 DSH 宿主**：
 * `src/shared/legacyPiSession/convert/__tests__/seedImport.test.ts` 验转换（display
 * 行只成为 ignorable 事件、不进模型上下文），`src/dsh-host/bridge/__tests__/seedSession.test.ts`
 * 验宿主写入，`dshSharedHost.integration.test.ts` 的导入阶段用这份 rollout 在真宿主上
 * 走完一遍。留在这里的是只有 Main 侧才有的那一半：真实 rollout 文件读得对、敏感块
 * 不进上下文、而且**源文件一个字节都没被动过**。
 */
describe('Codex rollout to an importable conversation', () => {
  it('converts captured disk history without touching the source file', async () => {
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
    await adapter.assertUnchanged(sourceFile, converted.conversation.sourceFingerprint);
    expect(await readFile(sourceFile)).toEqual(original);

    const entries = converted.conversation.entries;
    expect(entries.some((entry) => entry.kind === 'user')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'assistant')).toBe(true);
    // 工具调用与加密块保留在转写结果里（导入后进转录、不进模型上下文），
    // 但不能泄进随便哪个文本字段。
    const spoken = JSON.stringify(
      entries.flatMap((entry) =>
        entry.kind === 'user' || entry.kind === 'assistant' ? [entry] : []
      )
    );
    expect(spoken).not.toContain('encrypted_content');
    expect(JSON.stringify(entries)).toContain('fixture_tool');
  }, 20_000);
});

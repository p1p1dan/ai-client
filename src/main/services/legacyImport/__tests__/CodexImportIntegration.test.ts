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
 * 那个写入方随旧引擎一起删了，而**写入这一半现在归 runtime 侧**：
 * `src/runtime/__tests__/nativeImport.test.ts` 验的是同一件事（发布、重开、两种
 * custom 条目、display 行不进模型上下文），`sessionInterop.test.ts` 再验写出来的
 * 文件能被 pi 自己的读取器打开。留在这里的是只有 Main 侧才有的那一半：真实
 * rollout 文件读得对、敏感块不进上下文、而且**源文件一个字节都没被动过**。
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

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isImportedConversation, legacyImportDedupeKey } from '@shared/types';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionScanner, readCodexSessionSource } from '../CodexSessionScanner';
import { CodexSourceAdapter } from '../CodexSourceAdapter';

const fixture = resolve(
  __dirname,
  '../../../../agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl'
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'codex-scan-'));
  roots.push(root);
  const directory = join(root, '2026', '09', '08');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'rollout-fixture.jsonl');
  await copyFile(fixture, file);
  return { root, file, scanner: new CodexSessionScanner(() => root) };
}

describe('Codex session source scanner', () => {
  it('converts into the existing import contract and detects source changes before publish', async () => {
    const { scanner, file } = await setup();
    const [summary] = await scanner.scan();
    const adapter = new CodexSourceAdapter(scanner);
    const source = {
      sourceKind: 'codex' as const,
      projectId: summary.projectId,
      sourceSessionId: summary.sessionId,
    };
    const first = await adapter.read(source);
    const second = await adapter.read(source);
    expect(isImportedConversation(first.conversation)).toBe(true);
    expect(legacyImportDedupeKey(first.conversation)).toBe(
      legacyImportDedupeKey(second.conversation)
    );
    expect(legacyImportDedupeKey(first.conversation)).not.toBe(
      legacyImportDedupeKey({ ...first.conversation, sourceKind: 'claude-code' })
    );
    await adapter.assertUnchanged(file, first.conversation.sourceFingerprint);
    await writeFile(file, `${await readFile(file, 'utf8')}\n`);
    await expect(
      adapter.assertUnchanged(file, first.conversation.sourceFingerprint)
    ).rejects.toThrow('changed before publish');
  });

  it('discovers date-partitioned sessions without retaining conversation bodies', async () => {
    const { scanner, file } = await setup();
    const summaries = await scanner.scan();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].projectId).toMatch(/^codex-[a-f0-9]{64}$/);
    expect(summaries[0]).not.toHaveProperty('rollout');
    const selected = await scanner.resolveSessionSource(
      summaries[0].projectId,
      summaries[0].sessionId
    );
    expect(selected.filePath).toBe(file);
    expect(selected.rollout.entries.length).toBeGreaterThan(0);
  });

  it('fingerprints source content and leaves its bytes untouched', async () => {
    const { file } = await setup();
    const before = await readFile(file);
    const first = await readCodexSessionSource(file);
    const second = await readCodexSessionSource(file);
    expect(first.fingerprint).toEqual(second.fingerprint);
    expect(await readFile(file)).toEqual(before);
    await writeFile(file, Buffer.concat([before, Buffer.from('\n')]));
    expect((await readCodexSessionSource(file)).fingerprint.contentHash).not.toBe(
      first.fingerprint.contentHash
    );
  });

  it('skips corrupt siblings and rejects a client-supplied unknown source id', async () => {
    const { root, scanner } = await setup();
    await writeFile(join(root, 'broken.jsonl'), '{');
    expect(await scanner.scan()).toHaveLength(1);
    await expect(scanner.resolveSessionSource('../outside', 'missing')).rejects.toThrow(
      'missing or ambiguous'
    );
  });

  it('treats a missing root as empty but propagates other root failures for source isolation', async () => {
    const { file, root } = await setup();
    expect(await new CodexSessionScanner(() => join(root, 'missing')).scan()).toEqual([]);
    await expect(new CodexSessionScanner(() => file).scan()).rejects.toThrow();
  });
});

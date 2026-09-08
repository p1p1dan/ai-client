import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { DEFERRED_SERVICES, PROMPT_SERVICE } from '../contracts.ts';
import { RuntimeHostError } from '../host/errors.ts';
import { instructionSource } from '../plugins/prompt/instructionSource.ts';
import { deferredSlots } from '../plugins/prompt/segments.ts';

let dir: string;
let root: string;
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-prompt-'));
  root = join(dir, 'project');
  await mkdir(root);
});
afterEach(async () => {
  for (const handle of runtimes.splice(0)) await handle.dispose();
  await rm(dir, { recursive: true, force: true });
});

async function runtime(options: Partial<RuntimeBootstrapOptions> = {}) {
  const faux = fauxProvider({
    provider: 'test',
    models: [{ id: 'test', name: 'Test', contextWindow: 128_000 }],
  });
  const handle = await createRuntime({
    env: {},
    traceDir: null,
    providers: [faux.provider],
    tools: { cwd: root },
    ...options,
  });
  runtimes.push(handle);
  return { handle, faux };
}

describe('P2 prompt service and HostIo instruction wiring', () => {
  it('assembles managed, borrowed, root and nested instructions in the actual request', async () => {
    const agentDir = join(dir, 'managed');
    const borrowed = join(dir, 'borrowed.md');
    await mkdir(agentDir);
    await mkdir(join(root, 'src'));
    await writeFile(join(agentDir, 'AGENTS.md'), 'MANAGED_RULE');
    await writeFile(borrowed, 'BORROWED_RULE');
    await writeFile(join(root, 'AGENTS.md'), 'ROOT_RULE');
    await writeFile(join(root, 'src', 'AGENTS.md'), 'SHADOWED_RULE');
    await writeFile(join(root, 'src', 'AGENTS.override.md'), 'NESTED_RULE');
    const { handle, faux } = await runtime({
      agentDir,
      prompt: { globals: [{ path: borrowed, label: 'Borrowed' }] },
    });
    const reads = vi.spyOn(handle.hostIo, 'readFile');
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('done');
      },
    ]);
    const result = await handle.run({ prompt: 'inspect', targetPath: 'src/file.ts' });
    expect(result.success).toBe(true);
    const prompt = prompts[0];
    const order = [
      'MANAGED_RULE',
      'BORROWED_RULE',
      'ROOT_RULE',
      'NESTED_RULE',
      'Mode: agent',
      'Permission gear: ask',
    ];
    expect(order.every((part) => prompt.includes(part))).toBe(true);
    expect(order.map((part) => prompt.indexOf(part))).toEqual(
      order.map((part) => prompt.indexOf(part)).sort((a, b) => a - b)
    );
    expect(prompt).not.toContain('SHADOWED_RULE');
    expect(reads).toHaveBeenCalledWith(join(root, 'AGENTS.md'), {
      maxBytes: 32_768,
      overflow: 'truncate',
    });
    expect(
      result.trace.steps.find((step) => step.detail.event === 'run_start')?.detail
    ).toMatchObject({ prompt_source: 'assembled' });
    expect(handle.ctx.get(PROMPT_SERVICE) !== undefined).toBe(true);
    expect(DEFERRED_SERVICES).not.toHaveProperty(PROMPT_SERVICE);
    expect(deferredSlots().map((slot) => slot.id)).toEqual(['skills']);
  });

  it('keeps the static prefix stable while mode, gear and project rules change between runs', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'FIRST_RULE');
    const { handle } = await runtime();
    const first = await handle.prompt.compose();
    expect(first.text).toContain('FIRST_RULE');
    handle.permissions?.configure({ mode: 'plan', gear: 'auto' });
    await writeFile(join(root, 'AGENTS.md'), 'SECOND_RULE');
    const next = await handle.prompt.compose();
    expect(next.text).toContain('Mode: plan');
    expect(next.text).toContain('Permission gear: auto');
    expect(next.text).toContain('SECOND_RULE');
    expect(next.text).not.toContain('FIRST_RULE');
    expect(next.staticPrefixBytes).toBe(first.staticPrefixBytes);
    expect(Buffer.from(next.text).subarray(0, next.staticPrefixBytes)).toEqual(
      Buffer.from(first.text).subarray(0, first.staticPrefixBytes)
    );
  });

  it.each([
    'fixed probe',
    '',
  ])('preserves the explicit system prompt %j without reading instruction files', async (systemPrompt) => {
    const { handle, faux } = await runtime();
    const reads = vi.spyOn(handle.hostIo, 'readFile');
    faux.setResponses([
      (context) => {
        expect(context.systemPrompt).toBe(systemPrompt);
        return fauxAssistantMessage('done');
      },
    ]);
    expect((await handle.run({ prompt: 'hi', systemPrompt })).success).toBe(true);
    expect(reads).not.toHaveBeenCalled();
  });

  it('loads globals without an implicit workspace and advertises no tools in the tool-less lane', async () => {
    const file = join(dir, 'global.md');
    await writeFile(file, 'GLOBAL_ONLY');
    const { handle } = await runtime({
      tools: undefined,
      prompt: { globals: [{ path: file, label: 'Global' }] },
    });
    const prompt = await handle.prompt.compose();
    expect(prompt.text).toContain('GLOBAL_ONLY');
    expect(prompt.segments.map((segment) => segment.slot)).toEqual([
      'identity',
      'collaboration',
      'project-instructions',
    ]);
  });

  it('bounds HostIo reads without splitting UTF-8 characters', async () => {
    await writeFile(join(root, 'AGENTS.md'), '中文中文');
    const { handle } = await runtime({ prompt: { maxBytes: 4 } });
    const composed = await handle.prompt.compose();
    expect(composed.text).toContain('中');
    expect(composed.text).not.toContain('文');
    expect(composed.text).not.toContain('\uFFFD');
  });

  it('skips an instruction symlink that escapes the workspace before reading its target', async () => {
    const outside = join(dir, 'outside.md');
    await writeFile(outside, 'OUTSIDE_SECRET');
    await symlink(outside, join(root, 'AGENTS.md'));
    const { handle } = await runtime();
    const reads = vi.spyOn(handle.hostIo, 'readFile');
    expect((await handle.prompt.compose()).text).not.toContain('OUTSIDE_SECRET');
    expect(reads).not.toHaveBeenCalled();
  });

  it('ignores absent instruction files but propagates a TSD read failure', async () => {
    const { handle } = await runtime();
    const source = instructionSource(handle.hostIo);
    expect(await source.readText(join(root, 'absent'))).toBeUndefined();
    await writeFile(join(root, 'AGENTS.md'), '%TSD-Header-###%encrypted');
    await expect(handle.prompt.compose()).rejects.toMatchObject({ code: 'io_tsd_unavailable' });
    vi.spyOn(handle.hostIo, 'readFile').mockRejectedValue(
      new RuntimeHostError('runtime_disposed', 'disposed')
    );
    await expect(source.readText(join(root, 'AGENTS.md'))).rejects.toMatchObject({
      code: 'runtime_disposed',
    });
  });
});

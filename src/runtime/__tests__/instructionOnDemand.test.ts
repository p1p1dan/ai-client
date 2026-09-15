/**
 * T035 gate — decision 007's on-demand instruction tier, end to end.
 *
 * Two halves, and they fail differently:
 *
 * 1. **The tools half.** A read / edit / write / grep that lands on a file
 *    inside the workspace has to bring that directory's instruction file into
 *    scope, and a call that lands anywhere else must not. Nothing throws when
 *    this is wrong — the model simply never sees a CLAUDE.md the user wrote, or
 *    sees one from a directory it never worked in.
 * 2. **The loop half.** What came into scope has to reach the very next
 *    request, exactly once, as a message the projector draws no user bubble for
 *    and the session file keeps its mark on. Get the mark wrong and the person
 *    sees a message they never typed; get the once wrong and every turn re-pays
 *    for the same file.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context as PiContext } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInternalMessage } from '../../shared/internalMessage.ts';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';

let workspace: string;
let outside: string;
const runtimes: RuntimeHandle[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'on-demand-'));
  outside = await mkdtemp(join(tmpdir(), 'on-demand-out-'));
  await mkdir(join(workspace, 'src', 'deep'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'ROOT_RULE');
  await writeFile(join(workspace, 'src', 'AGENTS.md'), 'SRC_RULE');
  await writeFile(join(workspace, 'src', 'deep', 'CLAUDE.md'), 'DEEP_RULE');
  await writeFile(join(workspace, 'src', 'file.ts'), 'const needle = 1;\n');
  await writeFile(join(workspace, 'top.ts'), 'const needle = 2;\n');
  await writeFile(join(outside, 'AGENTS.md'), 'STRANGER_RULE');
  await writeFile(join(outside, 'file.ts'), 'const needle = 3;\n');
});
afterEach(async () => {
  for (const handle of runtimes.splice(0)) await handle.dispose();
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function runtime(options: Partial<RuntimeBootstrapOptions> = {}) {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  faux.setResponses([fauxAssistantMessage('ready')]);
  const handle = await createRuntime({
    env: {},
    traceDir: null,
    providers: [faux.provider],
    host: standaloneHost({ PATH: process.env.PATH }),
    tools: { cwd: workspace },
    // `auto` so a write or a read outside the workspace is not waiting on an
    // approval this suite has no one to answer.
    permissions: { gear: 'auto', projectTrusted: true },
    ...options,
  });
  runtimes.push(handle);
  return { handle, faux };
}

async function call(handle: RuntimeHandle, name: string, params: Record<string, unknown>) {
  const tool = handle.ctx.runtimeTools.list().find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(`test-${name}`, params);
}

const taken = (handle: RuntimeHandle) =>
  (handle.prompt.takePendingInstructions?.() ?? []).map((entry) => entry.content);

describe('on-demand project instructions · the tools half', () => {
  it('brings every directory between the workspace and the file into scope, outermost first', async () => {
    const { handle } = await runtime();
    await call(handle, 'read', { path: 'src/deep/../file.ts' });
    expect(taken(handle)).toEqual(['SRC_RULE']);
    await call(handle, 'read', { path: 'src/deep/CLAUDE.md' });
    expect(taken(handle)).toEqual(['DEEP_RULE']);
  });

  it('loads each directory once, however many times the agent goes back', async () => {
    const { handle } = await runtime();
    await call(handle, 'read', { path: 'src/file.ts' });
    expect(taken(handle)).toEqual(['SRC_RULE']);
    await call(handle, 'read', { path: 'src/AGENTS.md' });
    expect(taken(handle)).toEqual([]);
  });

  it('stays quiet for a file in the workspace root, which the prompt already has', async () => {
    const { handle } = await runtime();
    await call(handle, 'read', { path: 'top.ts' });
    expect(taken(handle)).toEqual([]);
  });

  it('stays quiet for a file outside the workspace', async () => {
    const { handle } = await runtime();
    await call(handle, 'read', { path: join(outside, 'file.ts') });
    expect(taken(handle)).toEqual([]);
  });

  it('triggers on edit, write and grep too, not only read', async () => {
    const edited = await runtime();
    await call(edited.handle, 'edit', {
      path: 'src/file.ts',
      edits: [{ oldText: 'const needle = 1;', newText: 'const needle = 11;' }],
    });
    expect(taken(edited.handle)).toEqual(['SRC_RULE']);

    const written = await runtime();
    await call(written.handle, 'write', { path: 'src/new.ts', content: 'export {};\n' });
    expect(taken(written.handle)).toEqual(['SRC_RULE']);

    const grepped = await runtime();
    await call(grepped.handle, 'grep', { pattern: 'needle', path: 'src' });
    expect(taken(grepped.handle)).toEqual(['SRC_RULE']);
  });

  it('stays quiet when the workspace is not trusted', async () => {
    const { handle } = await runtime({ permissions: { gear: 'auto' } });
    await call(handle, 'read', { path: 'src/file.ts' });
    expect(taken(handle)).toEqual([]);
  });

  it('still recognises the subtree when the workspace is opened through a symlink', async () => {
    // Every path a tool reports has been through `canonicalPath`, so the root
    // it is compared against has to be canonical too. On macOS the everyday
    // temp directory is `/var` → `/private/var`, and a raw `tools.cwd` would
    // make every file in the workspace look like a file outside it.
    const link = join(outside, 'link');
    await symlink(workspace, link);
    const { handle } = await runtime({ tools: { cwd: link } });
    await call(handle, 'read', { path: 'src/file.ts' });
    expect(taken(handle)).toEqual(['SRC_RULE']);
  });

  it('adds the local file only when the local source is on', async () => {
    await writeFile(join(workspace, 'src', 'CLAUDE.local.md'), 'SRC_LOCAL_RULE');
    const on = await runtime();
    await call(on.handle, 'read', { path: 'src/file.ts' });
    expect(taken(on.handle)).toEqual(['SRC_RULE', 'SRC_LOCAL_RULE']);

    const off = await runtime({ settingSources: ['user', 'project'] });
    await call(off.handle, 'read', { path: 'src/file.ts' });
    expect(taken(off.handle)).toEqual(['SRC_RULE']);
  });
});

describe('on-demand project instructions · the loop half', () => {
  /**
   * Reads `src/file.ts` on the first turn, then answers.
   *
   * Records each request's messages as JSON rather than the live object: a
   * `Context` carries the tool definitions, whose `execute` is a function, so
   * anything structural (a clone, a deep equality) has to go through the wire
   * shape instead.
   */
  function readThenAnswer(turns: string[]) {
    const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    let index = 0;
    faux.setResponses(
      Array.from({ length: 8 }, () => (context: PiContext) => {
        turns.push(JSON.stringify(context.messages));
        return index++ === 0
          ? fauxAssistantMessage([fauxToolCall('read', { path: 'src/file.ts' })], {
              stopReason: 'toolUse',
            })
          : fauxAssistantMessage('done');
      })
    );
    return faux;
  }

  async function build(events?: RuntimeEventDraft[]) {
    const turns: string[] = [];
    const faux = readThenAnswer(turns);
    const handle = await createRuntime({
      env: {},
      traceDir: null,
      providers: [faux.provider],
      host: standaloneHost({ PATH: process.env.PATH }),
      tools: { cwd: workspace },
      permissions: { gear: 'auto', projectTrusted: true },
      session: { cwd: workspace, mode: 'create', file: join(workspace, 'session.jsonl') },
      loop: { singleTurn: false },
    });
    runtimes.push(handle);
    if (events) handle.events.subscribe((event) => events.push(event));
    return { handle, turns };
  }

  it('carries a directory discovered after the last turn boundary into the next run', async () => {
    // A tool call whose turn was the run's last one has no later turn boundary
    // to ride into — the run ended first. Without a drain at the start of the
    // NEXT run, that instruction file would sit in the queue for the rest of
    // the session and the model would never see it.
    const { handle, turns } = await build();
    await call(handle, 'read', { path: 'src/file.ts' });
    await handle.run({ prompt: 'now what' });
    expect(turns[0]).toContain('SRC_RULE');
  });

  it('puts the discovered file in the next request and never in a later one', async () => {
    const { handle, turns } = await build();
    const result = await handle.run({ prompt: 'look at src' });
    expect(result.success).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // Turn 1 asked for the read, so it cannot yet know about `src/AGENTS.md`.
    expect(turns[0]).not.toContain('SRC_RULE');
    expect(turns[1]).toContain('SRC_RULE');
    // Once, not once per turn: the last request still carries exactly one copy.
    expect((turns.at(-1) ?? '').split('SRC_RULE').length - 1).toBe(1);
  });

  it('draws no user bubble for it and keeps the mark in the session file', async () => {
    const events: RuntimeEventDraft[] = [];
    const { handle } = await build(events);
    await handle.run({ prompt: 'look at src', attemptId: 'attempt-1' });
    await handle.session?.flush();

    const userStarts = events.filter(
      (event) => event.type === 'message.started' && event.payload.role === 'user'
    );
    expect(userStarts).toHaveLength(1);
    expect(userStarts[0].payload).toMatchObject({ attemptId: 'attempt-1' });
    expect(
      JSON.stringify(events.filter((event) => event.type.startsWith('message.')))
    ).not.toContain('SRC_RULE');

    const users = (handle.session?.snapshot().messages ?? []).filter(
      (message) => message.role === 'user'
    );
    expect(users).toHaveLength(2);
    expect(isInternalMessage(users[0])).toBe(false);
    expect(isInternalMessage(users[1])).toBe(true);
    // And on disk, because a reopen is where an unmarked one gets mistaken for
    // the newest thing the user asked for.
    const raw = await readFile(join(workspace, 'session.jsonl'), 'utf8');
    expect(raw).toContain('SRC_RULE');
    expect(raw).toContain('project-instructions');
    const history = (handle.session?.history() ?? []).filter((message) => message.role === 'user');
    expect(history).toHaveLength(1);
  });
});

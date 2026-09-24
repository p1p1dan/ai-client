/**
 * Ctrl+Enter interjection (`worker.interject` → `AgentLoopPlugin.interject()`).
 *
 * The signal is a "stop at the next turn boundary", not an abort: the current
 * iteration finishes its tools and streams its message, then the loop exits so
 * the renderer's queue can deliver the interjection as the next turn.
 *
 * The cases below pin the two halves separately: that the flag does stop the
 * loop at a boundary, and that it is scoped to the run that was live when it
 * arrived. The second half is the regression this file exists for — a flag
 * owned by the plugin rather than by the run would be consumed by the NEXT
 * run's first boundary check, stopping a turn the user never asked to stop.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { neverAsked } from './fixtures/approval.ts';

/** A turn that calls `read`, which is what makes the loop ask again. */
const readCall = (id: string) =>
  fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id })], {
    stopReason: 'toolUse',
  });

describe('Ctrl+Enter interjection', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'runtime-interject-'));
    await writeFile(join(workspace, 'notes.txt'), 'notes\n', 'utf8');
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function boot(replies: ReturnType<typeof fauxAssistantMessage>[]): Promise<RuntimeHandle> {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-interject', name: 'Interject probe' }],
    });
    faux.setResponses(replies);
    runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      workspace: { cwd: workspace },
      permissions: { approve: neverAsked, projectTrusted: true },
      // No ceiling: these cases are about the interjection ending the loop, so
      // nothing else may be allowed to end it first.
      loop: { turnCeiling: 64, singleTurn: false },
    });
    return runtime;
  }

  it('reports false when no run is live, and does not arm the next one', async () => {
    const handle = await boot([
      readCall('t1'),
      fauxAssistantMessage('first run, turn two'),
      fauxAssistantMessage('second run'),
    ]);

    // Nothing has run yet: there is no live run to interject into.
    expect(handle.loop.interject()).toBe(false);

    // The run that follows must not inherit a signal aimed at a run that did
    // not exist. A plugin-level flag would have been consumed right here, on
    // this run's first boundary check, ending it a turn early.
    const result = await handle.run({ prompt: 'go', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.text).toContain('first run, turn two');
  });

  it('reports false once the run has ended, and does not arm the next one', async () => {
    const handle = await boot([
      fauxAssistantMessage('done in one'),
      readCall('t2'),
      fauxAssistantMessage('the run after the interjection'),
    ]);

    const first = await handle.run({ prompt: 'go', systemPrompt: 'probe' });
    expect(first.turns).toBe(1);

    // The run is over. The signal cannot reach it, so the answer is false —
    // the composer relies on this to tell the user the stop is NOT coming.
    expect(handle.loop.interject()).toBe(false);

    const second = await handle.run({ prompt: 'go again', systemPrompt: 'probe' });
    expect(second.turns).toBe(2);
    expect(second.text).toContain('the run after the interjection');
  });

  it('stops the live run at its next turn boundary', async () => {
    const handle = await boot([
      readCall('t1'),
      // The turn the interjection prevents. `faux` hands out one scripted
      // response per request, so an unconsumed entry here is the proof that the
      // loop never went back to the model.
      fauxAssistantMessage('the turn the interjection prevented'),
      fauxAssistantMessage('the run after'),
    ]);

    // Arm the signal while the first turn's tool call is in flight, so this is
    // the boundary check that consumes it rather than a later one.
    let armed = false;
    const run = handle.run({
      prompt: 'go',
      systemPrompt: 'probe',
      onEvent: () => {
        if (armed) return;
        armed = true;
        handle.loop.interject();
      },
    });

    const result = await run;
    // One turn, and the run ends on the tool boundary it stopped at: the loop
    // did not ask the model again, so the second scripted response was never
    // spent. That is the difference between this and a Stop (which aborts the
    // turn in flight).
    expect(result.turns).toBe(1);
    expect(result.stopReason).toBe('toolUse');

    // The signal was consumed by that boundary check, so the run that follows
    // is untouched: it takes the response the stopped run left in the queue —
    // a second interjection would be needed to stop this one.
    const next = await handle.run({ prompt: 'go again', systemPrompt: 'probe' });
    expect(next.success).toBe(true);
    expect(next.text).toBe('the turn the interjection prevented');
  });

  it('records the stop on the trace', async () => {
    const handle = await boot([fauxAssistantMessage('one turn'), fauxAssistantMessage('unused')]);

    const run = handle.run({
      prompt: 'go',
      systemPrompt: 'probe',
      onEvent: () => {
        handle.loop.interject();
      },
    });
    const result = await run;

    const notes = result.trace.steps.filter((step) => step.type === 'note');
    expect(notes.some((step) => step.detail?.event === 'turn_stopped_by_interjection')).toBe(true);
  });

  it('is harmless when the loop is single-turn and already stopping', async () => {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-interject', name: 'Interject probe' }],
    });
    faux.setResponses([fauxAssistantMessage('single turn')]);
    runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      permissions: { approve: neverAsked, projectTrusted: true },
      loop: { singleTurn: true },
    });

    const run = runtime.run({
      prompt: 'go',
      systemPrompt: 'probe',
      onEvent: () => {
        // Arming a loop that is stopping anyway must not throw or corrupt the
        // run's own stop accounting.
        runtime?.loop.interject();
      },
    });
    const result = await run;
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.text).toBe('single turn');
  });
});

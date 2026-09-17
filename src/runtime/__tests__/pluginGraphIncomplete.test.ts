/**
 * The `plugin_graph_incomplete` fallback in `bootstrap.ts` (spike-02).
 *
 * `createRuntime` awaits every `ctx.plugin()` fiber and THEN asks the context
 * for each required service BY NAME, because Cordis settles a fiber whose
 * injects are unmet rather than throwing — the PENDING trap `bootstrap.test.ts`
 * opens with, pinned by `spikes/p0-cordis-semantics.ts`. That name check is the
 * only thing standing between "a plugin never activated" and a runtime that
 * reports ready with a hole in it.
 *
 * Until this file it had never executed: `plugin_graph_incomplete` appeared
 * nowhere but its own `throw`, so a change that made the check unreachable —
 * or one that silently dropped a name out of `required` — would have left the
 * whole suite green. Batch D's cordis-spike-d1 review raised that as spike-02.
 *
 * Reaching it needs a plugin whose injects nobody satisfies, and no combination
 * of options produces one: every `static inject` in the runtime names a service
 * registered unconditionally, which is itself the property keeping the graph
 * sound. So the case replaces one plugin with a version that asks for a service
 * that does not exist — the shape a Cordis semantics change or a mis-declared
 * `inject` would actually arrive in.
 *
 * Its own file rather than a case inside `bootstrap.test.ts`: the module mock
 * applies to the whole file it lives in, and every other bootstrap case needs
 * the real tools plugin.
 */

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { Context } from 'cordis';
import { describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../bootstrap.ts';
import { neverAsked } from './fixtures/approval.ts';

vi.mock('../plugins/tools/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plugins/tools/index.ts')>();
  // Imported HERE, not at the top of the file: `vi.mock` factories are hoisted
  // above the module's own imports, so a top-level `Service` binding is still
  // in its temporal dead zone when this runs.
  const { Service } = await import('cordis');
  /** Keeps the real service NAME, so `required` still asks for `runtimeTools`. */
  class StrandedToolsPlugin extends Service {
    /** Nothing registers this, so the fiber settles and the service never lands. */
    static inject = ['serviceNobodyRegisters'];
    constructor(ctx: Context) {
      super(ctx, actual.TOOLS_SERVICE);
    }
  }
  return { ...actual, ToolsPlugin: StrandedToolsPlugin };
});

function faux(reply = 'ready') {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-p0', name: 'Faux P0 probe' }],
  });
  handle.setResponses([fauxAssistantMessage(reply)]);
  return handle;
}

describe('plugin_graph_incomplete', () => {
  it('refuses the runtime and names the service that never landed', async () => {
    /**
     * Reported as a plain value rather than asserted on the rejection, for the
     * reason `bootstrap.test.ts` gives at its own guard case: if the check ever
     * stops firing this call SUCCEEDS, and a `rejects` matcher would then try to
     * print a live `RuntimeHandle` whose Cordis context throws on the probes the
     * pretty-printer makes, burying the real failure.
     */
    const outcome = await createRuntime({
      providers: [faux().provider],
      env: {},
      traceDir: null,
      tools: { cwd: process.cwd() },
      permissions: { approve: neverAsked },
    }).then(
      async (handle) => {
        await handle.dispose();
        return { built: true, code: undefined, message: '' };
      },
      (error: unknown) => ({
        built: false,
        code: (error as { code?: string }).code,
        message: (error as Error).message,
      })
    );

    expect(outcome).toMatchObject({ built: false, code: 'plugin_graph_incomplete' });
    // The name IS the value of this error: it says which plugin is stranded, and
    // a runtime that reported "ready" here would fail later at the first tool
    // call with nothing pointing back at the graph.
    expect(outcome.message).toContain('runtimeTools');
    // The permission plugin registered normally, so it must not be accused too —
    // this is what fails if `required` ever starts listing services wholesale.
    expect(outcome.message).not.toContain('runtimePermissions');
  });
});

/**
 * dsh-rebase decision 131 (decision 073 rule 1, decision 120 item 27): a
 * plugin tool's own title for one of its calls, asked of DSH's tool registry.
 *
 * DSH keeps `ToolDefinition.presentCall(args)` for host-local consumers — its
 * own Web client derives cards client-side instead (`dsh-tools` README, "Host
 * presentation descriptors"). It is pure and depends on the arguments alone,
 * so the live row (`liveEvents.ts`) and the replayed one (the history fold)
 * ask the same question and get the same answer. `defineTool` already answers
 * nothing for arguments that fail the tool's schema.
 *
 * Asked only for a tool that is not one of DSH's own (`isDshBuiltinTool`):
 * their rows are the P1-7c vocabulary's, so asking would only add bytes to
 * every recorded stream.
 */

import {
  type DshToolPresenter,
  isDshBuiltinTool,
  narrowToolCallPresentation,
} from '../../shared/dshToolPresentation.ts';

/** `ctx.tools` (dsh-tools' `ToolRuntime`), narrowed to the one lookup made here. */
export interface DshToolRegistryView {
  /**
   * The definition `scope` sees for `name` (scoped shadows global), or none.
   * "Presenters pass the calling agent so the rendered card matches the
   * definition that actually executed."
   */
  get(name: string, scope?: object): { presentCall?: (args: unknown) => unknown } | undefined;
}

/**
 * The presenter a live row or a history fold uses. `registry` and `scope` are
 * read per call: the registry is a Cordis service, and a session's agent (the
 * scope) is created after the runtime that asks. A lookup or a presenter that
 * throws costs the title, never the row.
 */
export function dshToolPresenter(
  registry: () => DshToolRegistryView | undefined,
  scope: () => object | undefined = () => undefined
): DshToolPresenter {
  return (name, args) => {
    if (!name || isDshBuiltinTool(name)) return undefined;
    try {
      const definition = registry()?.get(name, scope());
      if (typeof definition?.presentCall !== 'function') return undefined;
      return narrowToolCallPresentation(definition.presentCall(args));
    } catch {
      return undefined;
    }
  };
}

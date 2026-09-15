import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
  type PortableExtensionUiBridgeOptions,
} from '../../../agent-host/extensionUiBridge.ts';
import { PERMISSION_TIMEOUT_MS, type PermissionConfig } from './index.ts';

export interface RuntimeApprovalBridge {
  bridge: PortableExtensionUiBridge;
  approve: NonNullable<PermissionConfig['approve']>;
}

/**
 * cutover-17 / cutover-06 / permissions-15 — the fallback gate, and why it is
 * still here.
 *
 * Neither half of this runs in THIS app. `nativeWorkerRuntime` always passes
 * its own `permissions.approve`, so `bootstrap`'s `?? approval?.approve` never
 * falls through to the `approve` below; and since T025 stopped bundling the two
 * pi extensions, nothing else calls `uiContext` either, so the `bridge` half
 * has no producer to serve (see the header of `extensionUiBridge.ts`).
 *
 * It stays because it is the Extension UI embedding contract: a host that
 * embeds `src/runtime` and implements no `permission.requested` surface asks
 * through exactly this path, and `src/runtime/index.ts` exports it for that.
 * `src/runtime/__tests__/tools.test.ts` drives it end to end, which is what
 * keeps it from rotting while this app does not use it.
 *
 * Two things were wrong with that arm and both are fixed here:
 *
 *  - The three options were hardcoded Chinese, shown to whoever the embedder's
 *    dialog shows options to, with no locale anywhere in reach. They are now
 *    English catalog keys, which is this repo's translation convention (the
 *    English string IS the key) and the correct text when nothing translates.
 *  - The answer was mapped back by comparing the returned string to those
 *    literals. Any re-wording — a translation, a trailing space — silently
 *    turned "allow" into "deny", the safe-looking direction that hides the
 *    bug. The mapping is now by POSITION in the array that was sent, so the
 *    label text carries no meaning at all.
 */
const APPROVAL_CHOICES = [
  { label: 'Allow once', decision: 'allow-once' },
  { label: 'Allow for this session', decision: 'allow-session' },
  { label: 'Deny', decision: 'deny' },
] as const satisfies readonly {
  label: string;
  decision: 'allow-once' | 'allow-session' | 'deny';
}[];

export function createRuntimeApprovalBridge(
  options: PortableExtensionUiBridgeOptions,
  /**
   * permissions-15 — the deadline the engine will enforce, so the dialog and
   * the abort agree. Defaulted rather than hardcoded: both ends fall back to
   * `PERMISSION_TIMEOUT_MS` today, and a caller that shortens
   * `PermissionConfig.timeoutMs` without passing it here would leave the dialog
   * counting down long after the request was already denied.
   */
  timeoutMs: number = PERMISSION_TIMEOUT_MS
): RuntimeApprovalBridge {
  const bridge = createPortableExtensionUiBridge(options);
  const ui = bridge.uiContext as {
    select(
      title: string,
      values: string[],
      options: { signal: AbortSignal; timeout: number }
    ): Promise<string | undefined>;
  };
  const labels: string[] = APPROVAL_CHOICES.map((choice) => choice.label);
  return {
    bridge,
    approve: async (request, signal) => {
      const detail = request.command ?? request.path;
      const selected = await ui.select(`${request.tool}: ${detail.slice(0, 2000)}`, labels, {
        signal,
        timeout: timeoutMs,
      });
      // cutover-17 — index into the array we sent, so an unrecognised or
      // absent answer (timeout, cancel, a dialog that returns its own text)
      // lands on `deny` by construction rather than by string luck.
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      return APPROVAL_CHOICES[index]?.decision ?? 'deny';
    },
  };
}

/** The exact option strings `approve` offers, for callers that drive it. */
export const RUNTIME_APPROVAL_CHOICE_LABELS: readonly string[] = APPROVAL_CHOICES.map(
  (choice) => choice.label
);

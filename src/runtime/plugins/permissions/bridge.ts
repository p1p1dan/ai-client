import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
  type PortableExtensionUiBridgeOptions,
} from '../../../agent-host/extensionUiBridge.ts';
import type { PermissionConfig } from './index.ts';

export interface RuntimeApprovalBridge {
  bridge: PortableExtensionUiBridge;
  approve: NonNullable<PermissionConfig['approve']>;
}

/**
 * cutover-17 — the fallback gate, and why it is still here.
 *
 * This app never reaches `approve` below: `nativeWorkerRuntime` always passes
 * its own `permissions.approve` and `bootstrap`'s `??` therefore never falls
 * through. What IS reached in production is the `bridge` half — it is the
 * Extension UI channel a pi plugin's own `ui.select` travels on, and
 * `respondExtensionUi` / `cancelAll` / `dispose` all go through it. So the
 * function stays; only the dead arm was rebuilt rather than deleted, because
 * deleting it would also remove a supported way to embed this runtime (ask
 * through Extension UI, implement no `permission.requested` surface at all).
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
  options: PortableExtensionUiBridgeOptions
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
        timeout: 120_000,
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

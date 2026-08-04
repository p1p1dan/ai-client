/**
 * T-15: pure presentation model for hosting `TerminalPanel` in the new shell's
 * context panel. Pure — no React, no DOM — so vitest's node env covers it, the
 * same pattern as `workspace-shell/shellLayoutModel.ts`.
 *
 * Two presentations, and only one of them is new:
 * - 'full'    — the legacy dock: every group side by side, split / merge /
 *               cross-group tab drag available. Default, so every existing
 *               host keeps today's behaviour byte for byte.
 * - 'compact' — the ~380px context panel: one group at a time, split
 *               management parked until the user expands the panel.
 *
 * Nothing here decides LIFETIME. A group that 'compact' hides keeps its
 * terminals mounted at `HIDDEN_TERMINAL_GROUP_BOX`; only the box changes.
 * Unmounting a `ShellTerminal` detaches its pty, and a local session with
 * `persistOnDisconnect: false` is destroyed on the last detach
 * (`SessionManager.detach` → `localPtyManager.destroy`), so "hide" and
 * "unmount" are not interchangeable here.
 */

export type TerminalPresentation = 'compact' | 'full';

export interface DeriveTerminalPresentationInput {
  /** The context panel's expanded overlay flag (`useShellLayoutStore.expanded`). */
  expanded: boolean;
}

/** Expanded panel → the legacy multi-group layout; anything narrower → compact. */
export function deriveTerminalPresentation(
  input: DeriveTerminalPresentationInput
): TerminalPresentation {
  return input.expanded ? 'full' : 'compact';
}

/**
 * Split / merge / cross-group tab drag entry points. False in 'compact': the
 * second group would not be reachable, and a control that silently does
 * nothing is worse than a disabled one carrying the reason.
 */
export function canManageTerminalSplits(presentation: TerminalPresentation): boolean {
  return presentation === 'full';
}

/** Structural view of a terminal group — keeps this module free of `./types`. */
export interface TerminalGroupLike {
  id: string;
}

export interface VisibleTerminalGroupIdsInput {
  presentation: TerminalPresentation;
  groups: readonly TerminalGroupLike[];
  activeGroupId?: string | null;
}

/**
 * Which groups get a tab bar and an on-screen box.
 *
 * - 'full': every group, source order untouched.
 * - 'compact': exactly the active group. A missing or unknown `activeGroupId`
 *   falls back to the first group instead of returning nothing — the panel
 *   would otherwise look empty while ptys are still running behind it.
 * - no groups: empty, never a phantom id.
 */
export function visibleTerminalGroupIds(input: VisibleTerminalGroupIdsInput): string[] {
  const { presentation, groups, activeGroupId } = input;
  if (presentation === 'full') {
    return groups.map((group) => group.id);
  }
  if (groups.length === 0) {
    return [];
  }
  const active = groups.find((group) => group.id === activeGroupId);
  return [(active ?? groups[0]).id];
}

/** Percent geometry of one group inside the panel; `left`/`width` are 0..100. */
export interface TerminalGroupBox {
  id: string;
  left: number;
  width: number;
}

/**
 * Box handed to the terminals of a group 'compact' does not show. Full width,
 * never 0: xterm's `FitAddon` floors at `cols: 2` when it measures a zero-width
 * parent, and that measurement is forwarded to the pty and re-wraps whatever is
 * running in it. Hidden groups are hidden with `opacity-0 pointer-events-none`
 * over this box — same reason `ContextPanel` bans `display: none`.
 */
export const HIDDEN_TERMINAL_GROUP_BOX: Readonly<Omit<TerminalGroupBox, 'id'>> = Object.freeze({
  left: 0,
  width: 100,
});

export interface ResolveTerminalGroupLayoutInput extends VisibleTerminalGroupIdsInput {
  /** Per-group flex percentages; index-aligned with `groups`. */
  flexPercents?: readonly number[];
}

/**
 * Cumulative percent boxes for the visible groups, in visible order.
 *
 * 'compact' collapses to a single full-width box. 'full' walks `flexPercents`,
 * substituting an even share for any entry that is missing or not a positive
 * finite number — the legacy code indexed `flexPercents` directly and dropped
 * (unmounted, therefore killed) a terminal whose percentage was absent.
 */
export function resolveTerminalGroupLayout(
  input: ResolveTerminalGroupLayoutInput
): TerminalGroupBox[] {
  const { presentation, groups, flexPercents } = input;
  const visible = visibleTerminalGroupIds(input);
  if (visible.length === 0) {
    return [];
  }
  if (presentation === 'compact') {
    return [{ id: visible[0], ...HIDDEN_TERMINAL_GROUP_BOX }];
  }

  const evenShare = 100 / groups.length;
  const boxes: TerminalGroupBox[] = [];
  let left = 0;
  for (const [index, group] of groups.entries()) {
    const raw = flexPercents?.[index];
    const width = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : evenShare;
    boxes.push({ id: group.id, left, width });
    left += width;
  }
  return boxes;
}

/** Groups that exist but have no box this round — the "expand to see them" count. */
export function hiddenTerminalGroupCount(input: VisibleTerminalGroupIdsInput): number {
  return Math.max(0, input.groups.length - visibleTerminalGroupIds(input).length);
}

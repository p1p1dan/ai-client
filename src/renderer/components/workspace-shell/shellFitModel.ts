/**
 * Decision 209 (§4, §5): what the center row shows, end to end — the panes'
 * arrangement, the allocator's widths, and whether the slot right of the
 * conversation (the session rail, or a docked side chat) fits.
 *
 * The order of what gives way on a narrowing window:
 *  1. a sidebar wider than its floor (inside `resolveShellAllocation`);
 *  2. two pane columns stack into one (`stackPaneView`);
 *  3. panes that still do not fit beside the chat cover it as a drawer
 *     (`editorOverlay`);
 *  4. the slot: panes are squeezed to their floor to make room for it, and
 *     only when the conversation would still be under `slot.minChat` does the
 *     slot leave the screen.
 *
 * Pure, no React: node-env tests assert every rule here. Nothing is stored —
 * the shell derives it per render, so a wider window undoes every step.
 */
import {
  type ResolveShellAllocationInput,
  resolveShellAllocation,
  type ShellAllocation,
} from './centerLayoutModel';
import {
  type PaneColumns,
  type PaneKind,
  type PaneView,
  paneAreaMinWidth,
  stackPaneView,
} from './workPanelModel';

/** What wants the column right of the conversation, inside the chat column. */
export interface ShellSlot {
  width: number;
  /** The narrowest conversation it may leave beside it. */
  minChat: number;
}

export interface ShellFitInput {
  /** Everything the allocator needs except the pane terms, which the fit decides. */
  base: Omit<ResolveShellAllocationInput, 'editorOpen' | 'editorWidth' | 'editorMinWidth'>;
  /** `resolvePaneView`: what the user has open, before any narrowing. */
  view: PaneView;
  /** Open panes, least recently focused first (the store's `paneFocus`). */
  focus: readonly PaneKind[];
  /** The pane area's preferred width per column count (persisted, user-dragged). */
  paneWidths: Readonly<Record<PaneColumns, number>>;
  /** The rail or a docked side chat; null when neither wants the room. */
  slot: ShellSlot | null;
}

export interface ShellFit {
  /** The panes on screen, possibly stacked into one column. */
  view: PaneView;
  allocation: ShellAllocation;
  /** The input that produced `allocation`; the drag paths repaint from it. */
  input: ResolveShellAllocationInput;
  /** Whether the slot is on screen. False when there was no slot. */
  slotFits: boolean;
}

function columnsOf(view: PaneView): PaneColumns {
  return view.columns === 2 ? 2 : 1;
}

export function fitShell(input: ShellFitInput): ShellFit {
  const allocate = (view: PaneView, editorWidth?: number) => {
    const columns = columnsOf(view);
    const allocationInput: ResolveShellAllocationInput = {
      ...input.base,
      editorOpen: view.columns > 0,
      editorWidth: editorWidth ?? input.paneWidths[columns],
      editorMinWidth: paneAreaMinWidth(columns),
    };
    return { input: allocationInput, allocation: resolveShellAllocation(allocationInput) };
  };

  let view = input.view;
  let fit = allocate(view);
  // Step 2: two columns that would have to cover the chat stack into one first.
  if (fit.allocation.editorOverlay && view.columns === 2 && !view.expanded) {
    view = stackPaneView(view, input.focus);
    fit = allocate(view);
  }

  const slot = input.slot;
  if (!slot || !input.base.chatVisible) {
    return { view, ...fit, slotFits: false };
  }
  const fits = (allocation: ShellAllocation) =>
    !allocation.editorOverlay && allocation.chatWidth - slot.width >= slot.minChat;
  if (fits(fit.allocation)) {
    return { view, ...fit, slotFits: true };
  }
  // Step 4: squeeze the panes toward their floor (never below it) for the slot.
  if (view.columns > 0 && !fit.allocation.editorOverlay) {
    const want = fit.allocation.centerWidth - slot.width - slot.minChat;
    const squeezed = allocate(view, Math.max(paneAreaMinWidth(columnsOf(view)), want));
    if (fits(squeezed.allocation)) {
      return { view, ...squeezed, slotFits: true };
    }
  }
  return { view, ...fit, slotFits: false };
}

export interface ShellColumnFit extends ShellFit {
  /** A docked side chat fits beside the conversation (else it lies over it). */
  dockFits: boolean;
  /** The session rail is on screen as far as room goes. */
  railFits: boolean;
}

/**
 * Decision 209 §4: the column right of the conversation holds one thing. A
 * docked side chat takes it whether it fits beside the conversation or has
 * to lie over it: the rail stays off either way, so the side chat never lies
 * over a conversation squeezed between the sidebar and the rail. Without a
 * docked side chat, the column is the rail's while it fits.
 */
export function fitShellColumn(
  input: Omit<ShellFitInput, 'slot'> & { dock: ShellSlot | null; rail: ShellSlot | null }
): ShellColumnFit {
  const { dock, rail, ...rest } = input;
  const fit = fitShell({ ...rest, slot: dock ?? rail });
  return {
    ...fit,
    dockFits: dock !== null && fit.slotFits,
    railFits: dock === null && fit.slotFits,
  };
}

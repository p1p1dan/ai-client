/**
 * Decision 209 §5: which title-bar buttons stay on the bar and which move
 * into its ⋮ menu.
 *
 * The window used to stop at 960 wide, which is what kept every button on
 * the bar. Allowed down to 640, the bar runs out of room first: buttons that
 * do not fit move into ⋮ from the right — background tasks, files, changes,
 * terminal, side chat, the session rail toggle — so that the conversation's
 * title keeps at least `BAR_TITLE_MIN_WIDTH`. ⋮ and the window's own buttons
 * always stay.
 *
 * Pure: the widths are `SessionBar.tsx`'s classes, written down here so the
 * rule can be tested without a layout engine. Nothing is stored — a wider
 * window brings every button back.
 */

export type BarButton = 'rail' | 'side-chat' | 'terminal' | 'changes' | 'files' | 'tasks';

/** Left to right, as they sit on the bar; they leave from the right. */
export const BAR_BUTTON_ORDER: readonly BarButton[] = [
  'rail',
  'side-chat',
  'terminal',
  'changes',
  'files',
  'tasks',
];

/** The conversation's title never gets less than this while a button could leave. */
export const BAR_TITLE_MIN_WIDTH = 120;
/** A bar button: `size-7`. */
export const BAR_BUTTON_WIDTH = 28;
/** The bar's `gap-1`, before every child but the first. */
export const BAR_GAP = 4;
/** The divider after the session rail toggle: `mx-1 w-px`. */
export const BAR_DIVIDER_WIDTH = 9;
/** `WindowControls`: three `w-11` buttons, behind the bar's `ml-1`. */
export const BAR_WINDOW_CONTROLS_WIDTH = 4 + 3 * 44;
/** The bar's `pl-2`, and its `pr-2` when there are no window controls. */
const BAR_PADDING = 8;
/** The title block's own `pl-1`. */
const TITLE_PADDING = 4;

export interface BarOverflowInput {
  /** The bar's width (the center row); null before the shell is measured. */
  width: number | null;
  /** The buttons that would show, in any order. */
  buttons: readonly BarButton[];
  /** The sidebar's expand button at the bar's left end (sidebar collapsed). */
  expandSidebar: boolean;
  /** Windows and Linux: the frameless window's own buttons at the right end. */
  windowControls: boolean;
}

export interface BarOverflow {
  /** On the bar, left to right. */
  inline: BarButton[];
  /** In ⋮, in the order they sat on the bar. */
  overflow: BarButton[];
}

/** What a button takes on the bar: itself, its gap, and the rail's divider. */
export function barButtonWidth(button: BarButton): number {
  const own = BAR_BUTTON_WIDTH + BAR_GAP;
  return button === 'rail' ? own + BAR_DIVIDER_WIDTH + BAR_GAP : own;
}

/** Everything that always stays: padding, the expand button, the title's floor, ⋮, the window buttons. */
export function barFixedWidth(
  input: Pick<BarOverflowInput, 'expandSidebar' | 'windowControls'>
): number {
  return (
    BAR_PADDING +
    (input.expandSidebar ? BAR_BUTTON_WIDTH + BAR_GAP : 0) +
    TITLE_PADDING +
    BAR_TITLE_MIN_WIDTH +
    BAR_GAP +
    BAR_BUTTON_WIDTH +
    (input.windowControls ? BAR_GAP + BAR_WINDOW_CONTROLS_WIDTH : BAR_PADDING)
  );
}

export function resolveBarOverflow(input: BarOverflowInput): BarOverflow {
  const shown = BAR_BUTTON_ORDER.filter((button) => input.buttons.includes(button));
  // Unmeasured: everything on the bar rather than flash a menu-full of buttons.
  if (input.width === null || !Number.isFinite(input.width) || input.width <= 0) {
    return { inline: shown, overflow: [] };
  }
  let room = input.width - barFixedWidth(input);
  let kept = 0;
  // Filling from the left is leaving from the right: the first button that
  // does not fit takes every one after it into ⋮.
  for (const button of shown) {
    const width = barButtonWidth(button);
    if (width > room) break;
    room -= width;
    kept += 1;
  }
  return { inline: shown.slice(0, kept), overflow: shown.slice(kept) };
}

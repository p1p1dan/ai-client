/**
 * dsh-rebase P1-7a: the class strings the todo card and the goal bar share.
 *
 * Design system v2 §7.8: the strips above the composer wear the docked cards'
 * shell in its `strip` form (`DockCard kind="strip"`): `md` radius, the soft
 * border, the card surface, one 32px head, `text-ui`. The queue strip
 * (`queueStripWrapperClass`) uses the same frame.
 */

import { dockCardVariants } from '@/components/ui/dock-card';

/** The strip: the DockCard strip shell, grown by its body when open. */
export function panelStripClass(): string {
  return dockCardVariants({ kind: 'strip' });
}

/**
 * The 32px head (§4.2: one head height). Left inset 12px, then a 14px icon and
 * a 6px gap, so the label text starts at 32px -- the column an open body's
 * rows indent to (`todoItemClass`'s `pl-5` inside the body's `px-3`).
 */
export function panelStripHeadClass(): string {
  return 'flex h-8 min-w-0 shrink-0 items-center gap-1.5 pr-1 pl-3';
}

/** The head's label, which opens and closes the strip; truncates before any button gives way. */
export function panelStripLabelClass(): string {
  return 'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xs text-left focus-ring';
}

/** The truncating text inside the label (`min-w-0 flex-1 truncate`, the design system's pattern). */
export function panelStripTextClass(): string {
  return 'min-w-0 flex-1 truncate';
}

/**
 * The 24 px icon buttons (menu, open / close): a ghost inside the strip's
 * frame (§1 rule 1), the hover shell given to keyboard focus too.
 */
export function panelStripIconButtonClass(): string {
  return 'flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 ease-out hover:bg-fill-ghost-hover hover:text-foreground focus-visible:bg-fill-ghost-hover focus-visible:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-64';
}

/** The labelled 24 px action (暂停 / 继续 / 收起): ghost, the small tier (12px, the CJK floor). */
export function panelStripActionClass(): string {
  return 'h-6 gap-1 px-1.5 text-small';
}

/** What an open strip shows under its head (§4.2 compact inset). */
export function panelStripBodyClass(): string {
  return 'px-3 pb-2';
}

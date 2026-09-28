/**
 * dsh-rebase P1-7a: the class strings the todo card and the goal bar share.
 * One strip is the queue strip's row (`QueuedMessageStrip`: `rounded-sm border
 * bg-muted/50 text-meta`, 28 px folded) that can open in place, as the P1-7
 * prototype draws it: a 26 px head inside the 1 px border, the body under it.
 */

/** The strip: the queue row's surface, grown by its body when open. */
export function panelStripClass(): string {
  return 'min-w-0 rounded-sm border border-border bg-muted/50 text-meta';
}

/** The head row: 26 px + the border = the queue row's 28 px (`h-7`). */
export function panelStripHeadClass(): string {
  return 'flex h-6.5 min-w-0 items-center gap-1.5 pr-px pl-2';
}

/** The head's label, which opens and closes the strip; truncates before any button gives way. */
export function panelStripLabelClass(): string {
  return 'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-ring';
}

/** The truncating text inside the label (`min-w-0 flex-1 truncate`, the design system's pattern). */
export function panelStripTextClass(): string {
  return 'min-w-0 flex-1 truncate';
}

/**
 * The 24 px icon buttons (menu, open / close): the design system's icon
 * button, with the hover shell given to keyboard focus too.
 */
export function panelStripIconButtonClass(): string {
  return 'flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-64';
}

/** The labelled 24 px action (暂停 / 继续 / 收起): ghost, the meta size CJK needs. */
export function panelStripActionClass(): string {
  return 'h-6 gap-1 px-1.5 text-meta sm:h-6 sm:text-meta';
}

/** What an open strip shows under its head, indented past the head's icon. */
export function panelStripBodyClass(): string {
  return 'px-2 pb-1.5';
}

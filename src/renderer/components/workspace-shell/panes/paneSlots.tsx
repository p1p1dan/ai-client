/**
 * Layout 5d: a pane card has ONE header. A view inside a card puts its own
 * controls there (and, optionally, a context next to the title) through these
 * portals instead of drawing a second title row of its own.
 *
 * Outside a card (no provider) `PaneHeaderPortal` renders nothing; a view
 * that is also used elsewhere asks `usePaneHeaderSlots()` and keeps its own
 * toolbar when it gets null.
 */
import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

export interface PaneHeaderSlots {
  /** Right side of the header, before the card's own expand / close. */
  actions: HTMLElement | null;
  /** Right after the title: a branch, a tab strip, a count. */
  context: HTMLElement | null;
}

const PaneHeaderSlotsContext = createContext<PaneHeaderSlots | null>(null);

export const PaneHeaderSlotsProvider = PaneHeaderSlotsContext.Provider;

/** The enclosing card's header slots; null outside a pane card. */
export function usePaneHeaderSlots(): PaneHeaderSlots | null {
  return useContext(PaneHeaderSlotsContext);
}

export function PaneHeaderPortal({
  slot,
  children,
}: {
  slot: keyof PaneHeaderSlots;
  children: ReactNode;
}) {
  const target = usePaneHeaderSlots()?.[slot] ?? null;
  return target ? createPortal(children, target) : null;
}

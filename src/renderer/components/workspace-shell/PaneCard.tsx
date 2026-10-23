/**
 * Layout 5d (user feedback 2026-10-22; the reference desktop app's panes): one
 * card per pane. ONE header, 36px — icon, title, the view's own context and
 * actions (portaled in through `paneSlots`), then expand ⤢ and close ✕ — and
 * the content fills the rest. No tab strip, no second title row.
 *
 * The card is placed by the pane area (absolute, `paneSlotStyle`). A card
 * that is mounted but not on screen (a running terminal, the editor waiting
 * for a file-open intent, a keep-alive surface) stays in the area's box,
 * `invisible` + `opacity-0` + `inert`: never `display: none`, which would
 * hand xterm's FitAddon a 0×0 box and the pty `cols: 2`.
 */
import { Maximize2, Minimize2, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { PaneHeaderSlotsProvider } from './panes/paneSlots';
import {
  ESCAPE_OWNING_POPUP_SELECTOR,
  SURFACE_ESCAPE_HOLD_ATTR,
  shouldCloseOnEscape,
} from './shellLayoutModel';
import type { PaneKind } from './workPanelModel';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_ATTR = SURFACE_ESCAPE_HOLD_ATTR;

/** The drag payload's type: a pane header, never a file or a sidebar row. */
export const PANE_DRAG_TYPE = 'application/x-pilab-pane';

/**
 * The pane being dragged. `dragover` cannot read the payload, only its type,
 * and a card must not light up as a target for itself.
 */
let draggingPane: PaneKind | null = null;

/** The card's frame (design system v2: a soft hairline, the raised surface). */
export const PANE_CARD_CLASS =
  'absolute flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-soft bg-surface-2';

interface PaneCardProps {
  kind: PaneKind;
  icon: ReactNode;
  /** Already translated; also the card's accessible name. */
  title: string;
  /** The view puts its own context in the header (the diff pane's `base → branch`). */
  titleHidden?: boolean;
  /** On screen: placed in its slot. False: mounted, invisible, out of reach. */
  shown: boolean;
  /** The slot's box (`paneSlotStyle`); ignored while not shown. */
  slotStyle?: CSSProperties;
  focused: boolean;
  expanded: boolean;
  onFocus: (kind: PaneKind) => void;
  onClose: (kind: PaneKind) => void;
  onToggleExpanded: (kind: PaneKind) => void;
  /** The header drags the card onto another to trade slots (user, 2026-10-22). */
  reorderable?: boolean;
  /** Another card's header was dropped on this one. */
  onDropPane?: (dragged: PaneKind, target: PaneKind) => void;
  children: ReactNode;
}

export function PaneCard({
  kind,
  icon,
  title,
  titleHidden = false,
  shown,
  slotStyle,
  focused,
  expanded,
  onFocus,
  onClose,
  onToggleExpanded,
  reorderable = false,
  onDropPane,
  children,
}: PaneCardProps) {
  const { t } = useI18n();
  // State, not refs: a view's portal must re-render once its target exists.
  const [contextSlot, setContextSlot] = useState<HTMLDivElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const slots = useMemo(
    () => ({ context: contextSlot, actions: actionsSlot }),
    [contextSlot, actionsSlot]
  );
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  // A press on a header control (a view's action, ⤢, ✕) never starts a drag.
  const pressedOnControlRef = useRef(false);
  const acceptsDrop = (types: readonly string[]) =>
    reorderable && types.includes(PANE_DRAG_TYPE) && draggingPane !== null && draggingPane !== kind;

  return (
    <section
      aria-label={title}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      data-pane={kind}
      data-pane-shown={shown ? 'true' : 'false'}
      data-pane-focused={shown && focused ? 'true' : undefined}
      data-pane-drop-target={dropTarget ? 'true' : undefined}
      className={cn(
        PANE_CARD_CLASS,
        // `opacity-0` as well as `invisible`: Monaco's diff editor writes an
        // inline `visibility: visible` on both of its sides, which beats the
        // inherited `hidden` and left a closed editor's diff painted over the
        // chat. Opacity on the card cannot be overridden by a descendant.
        !shown && 'pointer-events-none invisible inset-0 opacity-0',
        dragging && 'opacity-60',
        dropTarget && 'ring-2 ring-ring/50'
      )}
      // Capture: the editor and the terminal handle drops of their own; a
      // pane drag is the card's before either sees it.
      onDragOverCapture={(event) => {
        if (!acceptsDrop([...event.dataTransfer.types])) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        if (!dropTarget) setDropTarget(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setDropTarget(false);
      }}
      onDropCapture={(event) => {
        setDropTarget(false);
        const dragged = draggingPane;
        if (!dragged || !acceptsDrop([...event.dataTransfer.types])) return;
        event.preventDefault();
        event.stopPropagation();
        onDropPane?.(dragged, kind);
      }}
      style={shown ? slotStyle : undefined}
      onPointerDownCapture={() => onFocus(kind)}
      onFocusCapture={() => onFocus(kind)}
      // Pane-scoped Escape (carried over from the 5a panel): closes THIS
      // pane. A subtree marked `data-surface-holds-escape` (a terminal running
      // vim, Monaco's find widget) opts out, and so does any open popup (it is
      // portaled, so it is queried on the document).
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement | null;
        const holdsEscape = !!target?.closest?.(`[${ESCAPE_HOLD_ATTR}]`);
        const popupOpen = !!document.querySelector(ESCAPE_OWNING_POPUP_SELECTOR);
        if (!shouldCloseOnEscape({ key: event.key, isOpen: shown, holdsEscape, popupOpen })) {
          return;
        }
        onClose(kind);
        event.stopPropagation();
      }}
    >
      <header
        className={cn(
          'flex h-9 shrink-0 items-center gap-1 pr-1 pl-3',
          reorderable && 'cursor-grab active:cursor-grabbing'
        )}
        draggable={reorderable}
        data-pane-drag-handle={reorderable ? '' : undefined}
        onPointerDownCapture={(event) => {
          pressedOnControlRef.current = !!(event.target as HTMLElement).closest?.(
            'button, a, input'
          );
        }}
        onDragStart={(event) => {
          if (!reorderable || pressedOnControlRef.current) {
            event.preventDefault();
            return;
          }
          draggingPane = kind;
          event.dataTransfer.setData(PANE_DRAG_TYPE, kind);
          event.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => {
          draggingPane = null;
          setDragging(false);
        }}
      >
        <span
          aria-hidden
          className="flex shrink-0 text-muted-foreground [&_svg:not([class*='size-'])]:size-4"
        >
          {icon}
        </span>
        <h2
          className={cn('shrink-0 text-ui font-medium text-foreground', titleHidden && 'sr-only')}
        >
          {title}
        </h2>
        <div
          ref={setContextSlot}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-small text-foreground-faint"
          data-pane-slot="context"
        />
        <div
          ref={setActionsSlot}
          className="flex shrink-0 items-center gap-0.5"
          data-pane-slot="actions"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onToggleExpanded(kind)}
          aria-label={t(expanded ? 'Restore pane' : 'Expand pane')}
          title={t(expanded ? 'Restore pane' : 'Expand pane')}
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onClose(kind)}
          aria-label={t('Close pane')}
          title={`${t('Close pane')} (Ctrl+\\)`}
        >
          <X className="size-4" />
        </Button>
      </header>
      <PaneHeaderSlotsProvider value={slots}>
        <div className="relative isolate min-h-0 flex-1">{children}</div>
      </PaneHeaderSlotsProvider>
    </section>
  );
}

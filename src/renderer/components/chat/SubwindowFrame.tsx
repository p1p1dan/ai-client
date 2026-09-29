/**
 * dsh-rebase P1-7b (decision 109 rule 1): the chrome both floating
 * sub-windows share — background jobs and subagents — as the P1-7
 * prototype draws it (evidence/p1-7-prototype-2026-09-28, `.subwin`).
 *
 * A card over the timeline (`bg-popover`, `border`, `rounded-lg`, the
 * design system's `shadow-lg` tier for a floating container), with a header
 * of two fixed lines so nothing is ever pushed out of it (the prototype's
 * header-overflow fix): the grip, icon, title and close button; then the
 * count and the window's own actions. Both lines truncate their text, never
 * their buttons. The body scrolls inside the card.
 *
 * Dragging by the first line moves the window inside its layer; where it was
 * left is kept for this run of the app only (prototype question 6).
 */

import { GripHorizontal, X } from 'lucide-react';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  type SubwindowKey,
  type SubwindowPosition,
  useSessionSubwindowsStore,
} from '@/stores/sessionSubwindows';
import { panelStripIconButtonClass } from './sessionPanelsLayout';
import { clampSubwindowPosition } from './subwindowsModel';

/** The card: the prototype's 340 px, narrower when the column is. */
export function subwindowClass(): string {
  return 'pointer-events-auto flex w-85 max-w-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-popover text-meta shadow-lg';
}

/** Header line 1: grip, icon, title, close — 30 px with its rule. */
export function subwindowTitleRowClass(draggable: boolean): string {
  return cn(
    'flex h-7.5 shrink-0 items-center gap-1.5 border-b border-border pr-1 pl-2',
    draggable && 'cursor-grab touch-none select-none active:cursor-grabbing'
  );
}

/** Header line 2: the count, then the window's actions. */
export function subwindowCountRowClass(): string {
  return 'flex min-h-6.5 shrink-0 items-center gap-1.5 border-b border-border pr-1 pl-2 text-muted-foreground';
}

interface SubwindowFrameProps {
  windowKey: SubwindowKey;
  icon: ReactNode;
  title: string;
  count: string;
  actions?: ReactNode;
  /** The layer the window moves in: its box clamps a drag. */
  layer: React.RefObject<HTMLDivElement | null>;
  /** Tallest the card may be (the room above the composer, shared with the other window). */
  maxHeight: number;
  /** Where it was dragged to, if anywhere: then it floats free of the stack. */
  position?: SubwindowPosition;
  children: ReactNode;
}

export function SubwindowFrame({
  windowKey,
  icon,
  title,
  count,
  actions,
  layer,
  maxHeight,
  position,
  children,
}: SubwindowFrameProps) {
  const { t } = useI18n();
  const close = useSessionSubwindowsStore((state) => state.close);
  const setPosition = useSessionSubwindowsStore((state) => state.setPosition);
  const card = useRef<HTMLElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const box = card.current?.getBoundingClientRect();
    const frame = layer.current?.getBoundingClientRect();
    if (!box || !frame) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: box.left - frame.left,
      top: box.top - frame.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const box = card.current?.getBoundingClientRect();
    const frame = layer.current?.getBoundingClientRect();
    if (!current || current.pointerId !== event.pointerId || !box || !frame) return;
    setPosition(
      windowKey,
      clampSubwindowPosition(
        {
          left: current.left + event.clientX - current.startX,
          top: current.top + event.clientY - current.startY,
        },
        { width: box.width, height: box.height },
        { width: frame.width, height: frame.height }
      )
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <section
      ref={card}
      className={cn(subwindowClass(), position && 'absolute')}
      style={{
        maxHeight,
        ...(position ? { left: position.left, top: position.top } : {}),
      }}
      aria-label={title}
      data-testid={`subwindow-${windowKey}`}
      data-dragged={position ? 'true' : undefined}
    >
      <div
        className={subwindowTitleRowClass(true)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setPosition(windowKey, null)}
        title={t('Drag to move; double-click to put it back')}
      >
        <GripHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-ui text-foreground">
          {title}
        </span>
        <button
          type="button"
          className={panelStripIconButtonClass()}
          aria-label={t('Close')}
          title={t('Close')}
          onClick={() => close(windowKey)}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className={subwindowCountRowClass()}>
        <span className="min-w-0 flex-1 truncate tabular-nums">{count}</span>
        {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
      </div>
      {/* A plain scroll container, as the todo card's list is: the card has
          only a max height, so a percentage-sized viewport inside it would
          never become definite enough to scroll. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">{children}</div>
    </section>
  );
}

/** The empty window's one line (prototype `.subwin-empty`). */
export function SubwindowEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-5 text-center text-muted-foreground">{children}</p>;
}

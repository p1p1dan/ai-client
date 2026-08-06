/**
 * T-22 (D19) batch 3: pointer-driven drag-to-resize shared by the sidebar
 * (right edge) and ContextPanel (left edge) handles.
 *
 * Every frame writes the DOM directly instead of calling `setState` — the
 * sidebar hosts the full session tree, so a per-frame re-render would visibly
 * lag. `onCommit` fires exactly once, on pointerup/pointercancel, so the
 * resolved width lands in the store once per drag. `resizing` itself only
 * flips twice per drag (start/end), which is a cheap enough re-render to drive
 * `data-resizing` declaratively.
 *
 * Round-12 (user report: dragging drops frames): pointer events fire faster
 * than the compositor paints — a 1000Hz mouse delivers ~16 `pointermove`s per
 * 60Hz frame, and the old code did a full clamp + style write on every one of
 * them. Each write invalidates layout, so a single frame could pay for a
 * dozen throwaway layouts before the one that actually painted. Moves are now
 * COALESCED into one `requestAnimationFrame` callback: the pointer handler
 * only records the target width, and at most one clamp + one paint happens per
 * frame. The last move before pointerup is applied synchronously on release so
 * a pending frame can never be dropped.
 */
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface UsePanelDragResizeInput {
  /** 'right' = handle on the element's right edge (sidebar); 'left' = left edge (panel). */
  side: 'left' | 'right';
  /** Committed width used as the drag baseline. */
  width: number;
  /** Element whose inline width is written every frame (no React re-render). */
  targetRef: RefObject<HTMLElement | null>;
  clamp: (width: number) => number;
  onCommit: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  disabled?: boolean;
  /**
   * Round-12: paint one drag frame. Supplied when the dragged edge moves more
   * than its own element — the shell's columns are allocated from one model,
   * so the panel's live width has to repaint the center row, chat and the
   * editor in the same frame or they tear apart mid-drag.
   *
   * When present the hook does NOT write `targetRef.style.width` itself: the
   * caller owns painting, and two writers would fight over the same pixel.
   */
  onDragFrame?: (width: number) => void;
}

export interface UsePanelDragResizeResult {
  resizing: boolean;
  handleProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void;
  };
}

export function usePanelDragResize({
  side,
  width,
  targetRef,
  clamp,
  onCommit,
  onResizingChange,
  disabled,
  onDragFrame,
}: UsePanelDragResizeInput): UsePanelDragResizeResult {
  const [resizing, setResizing] = useState(false);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const latestRef = useRef(width);
  const onResizingChangeRef = useRef(onResizingChange);
  onResizingChangeRef.current = onResizingChange;
  // rAF coalescing state. `pendingXRef` holds the newest pointer position;
  // `frameRef` is the scheduled frame, or null when nothing is queued.
  const frameRef = useRef<number | null>(null);
  const pendingXRef = useRef<number | null>(null);
  const onDragFrameRef = useRef(onDragFrame);
  onDragFrameRef.current = onDragFrame;
  const clampRef = useRef(clamp);
  clampRef.current = clamp;

  /** One clamp + one paint. Called at most once per animation frame. */
  function paint(clientX: number) {
    const delta = side === 'right' ? clientX - startXRef.current : startXRef.current - clientX;
    const next = clampRef.current(startWidthRef.current + delta);
    latestRef.current = next;
    const live = onDragFrameRef.current;
    if (live) {
      live(next);
      return;
    }
    const target = targetRef.current;
    if (target) {
      target.style.width = `${next}px`;
    }
  }

  function cancelFrame() {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }

  /** Apply whatever the pointer last reported, then stop the frame loop. */
  function flushPendingFrame() {
    cancelFrame();
    const pending = pendingXRef.current;
    pendingXRef.current = null;
    if (pending !== null) {
      paint(pending);
    }
  }

  function beginResizing() {
    draggingRef.current = true;
    setResizing(true);
    onResizingChange?.(true);
    const target = targetRef.current;
    if (target) {
      target.dataset.resizing = 'true';
    }
    document.documentElement.style.cursor = 'col-resize';
  }

  function endResizing() {
    // Land the newest pointer position before committing — otherwise a move
    // that arrived between the last frame and pointerup is silently lost and
    // the panel snaps back a few pixels on release.
    flushPendingFrame();
    draggingRef.current = false;
    pointerIdRef.current = null;
    setResizing(false);
    onResizingChange?.(false);
    const target = targetRef.current;
    if (target) {
      delete target.dataset.resizing;
    }
    document.documentElement.style.cursor = '';
    onCommit(latestRef.current);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (disabled || !e.isPrimary || e.button !== 0) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    startXRef.current = e.clientX;
    // Mid-transition grab must baseline on the actual DOM width, not the
    // committed prop — while the open/close width transition is animating,
    // `width` still reflects the pre-transition value and would make the
    // handle jump on the first move.
    const baseline = Math.round(targetRef.current?.getBoundingClientRect().width ?? width);
    startWidthRef.current = baseline;
    latestRef.current = baseline;
    beginResizing();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) {
      return;
    }
    // Record only. Everything expensive — the clamp, the model call behind it
    // and the style write that invalidates layout — happens once per frame in
    // the callback below, no matter how many moves arrive in between.
    pendingXRef.current = e.clientX;
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingXRef.current;
      pendingXRef.current = null;
      if (pending !== null && draggingRef.current) {
        paint(pending);
      }
    });
  }

  function endDrag(e: ReactPointerEvent<HTMLElement>) {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    endResizing();
  }

  function onLostPointerCapture(e: ReactPointerEvent<HTMLElement>) {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) {
      return;
    }
    // Capture was taken away by something other than our own release (e.g.
    // the OS/browser reassigning it) — the drag session is no longer
    // trustworthy. Cancel it: reset internal state without committing
    // `latestRef`, since it may not reflect a value the user actually settled on.
    cancelFrame();
    pendingXRef.current = null;
    draggingRef.current = false;
    pointerIdRef.current = null;
    setResizing(false);
    onResizingChangeRef.current?.(false);
    const target = targetRef.current;
    if (target) {
      delete target.dataset.resizing;
    }
    document.documentElement.style.cursor = '';
  }

  // Unmount-mid-drag safety net. StrictMode's dev-only double-invoke is
  // harmless: `draggingRef` is false on the fake unmount, so cleanup no-ops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount/unmount-only cleanup, reads refs at unmount time
  useEffect(() => {
    return () => {
      cancelFrame();
      pendingXRef.current = null;
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      // Notify the parent so its `data-resizing`/`sidebarResizing` state
      // doesn't linger past unmount and permanently disable its transition.
      // No `setResizing` here — the component is already gone — and no
      // commit, since an interrupted drag's latest value isn't trustworthy.
      onResizingChangeRef.current?.(false);
      document.documentElement.style.cursor = '';
      const target = targetRef.current;
      if (target) {
        delete target.dataset.resizing;
      }
    };
  }, []);

  return {
    resizing,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture,
    },
  };
}

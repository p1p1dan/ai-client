/**
 * T-22 (D19) batch 3: pointer-driven drag-to-resize shared by the sidebar
 * (right edge) and ContextPanel (left edge) handles.
 *
 * Every frame writes `targetRef.current.style.width` directly instead of
 * calling `setState` — the sidebar hosts the full session tree, so a
 * per-frame re-render would visibly lag. `onCommit` fires exactly once, on
 * pointerup/pointercancel, so the resolved width lands in the store once per
 * drag. `resizing` itself only flips twice per drag (start/end), which is a
 * cheap enough re-render to drive `data-resizing` declaratively.
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
}: UsePanelDragResizeInput): UsePanelDragResizeResult {
  const [resizing, setResizing] = useState(false);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const latestRef = useRef(width);
  const onResizingChangeRef = useRef(onResizingChange);
  onResizingChangeRef.current = onResizingChange;

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
    const delta = side === 'right' ? e.clientX - startXRef.current : startXRef.current - e.clientX;
    const next = clamp(startWidthRef.current + delta);
    latestRef.current = next;
    const target = targetRef.current;
    if (target) {
      target.style.width = `${next}px`;
    }
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

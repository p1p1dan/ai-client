/**
 * T-24: drop-zone decisions for `useFileDragDrop`, extracted as pure functions.
 *
 * The hook listens on `document` and used to silently swallow every drop when
 * its drop-zone ref was unbound (the new shell never bound it), because the
 * hit test lived inline in a `.tsx`-adjacent hook with no coverage. Keeping the
 * decisions here makes the failure mode assertable in vitest.
 */

export interface DragPoint {
  x: number;
  y: number;
}

/** Subset of DOMRect the hit test needs, so tests do not need a DOM. */
export interface DropZoneRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Minimal shape of a `DataTransfer` this check needs, so tests can build a
 * plain object literal instead of a real (jsdom-free) `DataTransfer`. A real
 * `DataTransfer` satisfies this structurally — callers pass `e.dataTransfer`
 * directly.
 */
export interface DragPayload {
  types?: readonly string[] | null;
  /** Only `kind` matters — `DataTransferItem.kind` is `'file' | 'string'`. */
  items?: ArrayLike<{ kind: string }> | null;
}

/**
 * True when the drag payload carries OS files (as opposed to text/HTML).
 *
 * `types` is the primary signal, but some non-Chromium-standard drag sources
 * never set its `'Files'` flag (T-24 audit risk) and would otherwise be
 * silently ignored (no `preventDefault`, so `drop` never even fires). `items`
 * is the fallback: any item whose `kind === 'file'` is also a file payload.
 * `items` (unlike the actual file data, e.g. `getAsFile()`) is readable from
 * `dragover` onward per the HTML5 DnD spec, so this is safe to call there —
 * not just from `drop`.
 */
export function hasFilePayload(payload: DragPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  if (payload.types && Array.from(payload.types).includes('Files')) {
    return true;
  }
  if (payload.items) {
    for (const item of Array.from(payload.items)) {
      if (item.kind === 'file') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Hit test against the registered drop zone.
 *
 * A missing rect means no shell bound the drop zone, so nothing is droppable —
 * callers must bind a ref rather than relying on an implicit "whole window"
 * fallback, which would change legacy behaviour whenever its sidebar collapses.
 */
export function isPointInsideDropZone(
  rect: DropZoneRect | null | undefined,
  point: DragPoint
): boolean {
  if (!rect) {
    return false;
  }
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/**
 * A `dragleave` only clears the highlight when the pointer actually left the
 * window. The original check only covered the top/left edges, so leaving via
 * the right/bottom edge left `isFileDragOver` stuck at true and armed an
 * unrelated later drop.
 */
export function isDragLeavingWindow(point: DragPoint, viewport: Viewport): boolean {
  return point.x <= 0 || point.y <= 0 || point.x >= viewport.width || point.y >= viewport.height;
}

/**
 * Validate a dropped OS path; returns null when it cannot be used.
 *
 * The value comes from `webUtils.getPathForFile`, i.e. a real filesystem path,
 * never user-typed text. Leading/trailing spaces are legal in directory names
 * on Linux and macOS, so the path is returned verbatim — trimming it would
 * hand AddRepositoryDialog a directory that does not exist. Whitespace is only
 * collapsed for the emptiness test.
 */
export function normalizeDroppedRepositoryPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return null;
  }
  return path;
}

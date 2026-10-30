/**
 * Reading anchor for the timeline (PiLab R1, FR-11.3 / AC-19).
 *
 * The viewport runs with `overflow-anchor: none` (F10-a: the timeline does its
 * own bottom-following, and Chromium's anchoring fought it). That left a reader
 * who is NOT following with nothing holding their place when layout changes
 * that they did not ask for: a running turn settling and folding its process
 * groups, a late result growing a row above them, older history arriving.
 *
 * This keeps the place by hand: on every scroll tick we record the element at
 * the reading line and the screen offset of it and its ancestors; after a
 * resize we find the first of them that still has a box and scroll by however
 * far it moved. Only scrollTop changes, never layout, so it cannot form the
 * F10 cycle (that needs a height that depends on scroll position).
 */

/** Below the one sticky element (the process-group head, `top-0`, ~28px). */
const READING_LINE_MIN_PX = 48;

export interface ReadingAnchor {
  /** The element at the reading line, then its ancestors up to the content root. */
  chain: Array<{ el: Element; top: number }>;
}

function isInStickyHead(el: Element): boolean {
  const summary = el.closest('summary');
  return summary !== null && getComputedStyle(summary).position === 'sticky';
}

export function captureReadingAnchor(
  viewport: HTMLElement,
  content: HTMLElement
): ReadingAnchor | null {
  const box = viewport.getBoundingClientRect();
  if (box.height <= 0) return null;
  const y = box.top + Math.max(READING_LINE_MIN_PX, box.height * 0.25);
  const x = box.left + box.width / 2;
  const hit = document
    .elementsFromPoint(x, y)
    .find((el) => content.contains(el) && el !== content && !isInStickyHead(el));
  if (!hit) return null;
  const chain: ReadingAnchor['chain'] = [];
  for (let el: Element | null = hit; el && el !== content; el = el.parentElement) {
    chain.push({ el, top: el.getBoundingClientRect().top });
  }
  return chain.length ? { chain } : null;
}

/**
 * How far the anchored place moved, in px (positive = down), measured on the
 * first element of the chain that is still in the document and has a box: a
 * paragraph inside a group that just folded falls back to the group itself.
 * `null` when nothing is measurable.
 */
export function readingAnchorShift(anchor: ReadingAnchor): number | null {
  for (const { el, top } of anchor.chain) {
    if (!el.isConnected || el.getClientRects().length === 0) continue;
    return el.getBoundingClientRect().top - top;
  }
  return null;
}

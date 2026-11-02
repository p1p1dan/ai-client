import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The rendered width of an element, kept current by a `ResizeObserver`.
 * `null` until measured, and wherever `ResizeObserver` does not exist.
 */
export function useElementWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const next = new ResizeObserver((entries) => {
      const measured = entries.at(-1)?.contentRect.width;
      if (measured !== undefined) setWidth(Math.round(measured));
    });
    next.observe(node);
    observer.current = next;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

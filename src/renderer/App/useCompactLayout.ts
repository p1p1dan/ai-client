import { useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_BREAKPOINT_PX = 768;

/**
 * Observe a container's width and derive a compact-layout boolean.
 * Uses ResizeObserver so it works with split panes and non-window resize changes.
 */
export function useCompactLayout(breakpointPx: number = DEFAULT_BREAKPOINT_PX) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let last = -1;
    const report = () => {
      const width = Math.ceil(el.getBoundingClientRect().width);
      if (width === last) return;
      last = width;
      setContainerWidth(width);
    };

    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();

    return () => observer.disconnect();
  }, []);

  const isCompact = useMemo(
    () => containerWidth < breakpointPx,
    [containerWidth, breakpointPx]
  );

  return {
    containerRef,
    containerWidth,
    isCompact,
  };
}


/**
 * dsh-rebase P1-7b (decision 109 rule 1; prototype 2026-09-28 scenes C–E):
 * the layer the two floating sub-windows live in — background jobs and
 * subagents, opened and hidden by the session bar's buttons.
 *
 * The layer covers the room above the composer and nothing else: it is laid
 * over the timeline (`SubwindowRegion` wraps what sits above the strips and
 * the composer), so no window can ever reach the input box or the two strips
 * above it — the prototype's `overlapsDock` check made structural. Windows
 * float at the top right, stacked, sharing the room when both are open; a
 * dragged one floats where it was left. They may cover timeline content:
 * that cost was the user's choice (decision 109; prototype question 4).
 */

import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import { BackgroundJobsWindow } from './BackgroundJobsWindow';
import { SubagentsWindow } from './SubagentsWindow';
import { SUBWINDOW_GAP_PX, subwindowMaxHeight } from './subwindowsModel';

/** The room above the composer, with the layer laid over it. */
export function subwindowRegionClass(): string {
  return 'relative flex min-h-0 flex-1 flex-col';
}

/** Wraps what sits above the composer (the timeline, or the start screen) and lays the layer over it. */
export function SubwindowRegion({
  sessionId,
  children,
}: {
  sessionId: string | null;
  children: ReactNode;
}) {
  return (
    <div className={subwindowRegionClass()}>
      {children}
      <SessionSubwindows sessionId={sessionId} />
    </div>
  );
}

export function SessionSubwindows({ sessionId }: { sessionId: string | null }) {
  const open = useSessionSubwindowsStore((state) => state.open);
  if (!sessionId || (!open.jobs && !open.agents)) return null;
  return <SubwindowLayer sessionId={sessionId} jobs={open.jobs} agents={open.agents} />;
}

function SubwindowLayer({
  sessionId,
  jobs,
  agents,
}: {
  sessionId: string;
  jobs: boolean;
  agents: boolean;
}) {
  const layer = useRef<HTMLDivElement | null>(null);
  const positions = useSessionSubwindowsStore((state) => state.positions);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 8 px from the top and from the composer's strips (the prototype's gap).
  const available = height - 2 * SUBWINDOW_GAP_PX;
  const maxHeight = subwindowMaxHeight(available, Number(jobs) + Number(agents));
  const stacked = (jobs && !positions.jobs) || (agents && !positions.agents);

  return (
    <div
      ref={layer}
      className="pointer-events-none absolute inset-0 z-20"
      data-testid="session-subwindows"
    >
      {stacked && (
        <div className="absolute top-2 right-3 flex max-w-[calc(100%-1.5rem)] flex-col items-end gap-2">
          {jobs && !positions.jobs && (
            <BackgroundJobsWindow sessionId={sessionId} layer={layer} maxHeight={maxHeight} />
          )}
          {agents && !positions.agents && (
            <SubagentsWindow sessionId={sessionId} layer={layer} maxHeight={maxHeight} />
          )}
        </div>
      )}
      {jobs && positions.jobs && (
        <BackgroundJobsWindow
          sessionId={sessionId}
          layer={layer}
          maxHeight={maxHeight}
          position={positions.jobs}
        />
      )}
      {agents && positions.agents && (
        <SubagentsWindow
          sessionId={sessionId}
          layer={layer}
          maxHeight={maxHeight}
          position={positions.agents}
        />
      )}
    </div>
  );
}

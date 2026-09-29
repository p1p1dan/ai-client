import { useEffect, useState } from 'react';

/**
 * dsh-rebase P1-7b: the sub-windows' own one-second clock, ticking only while
 * something in the window runs (plan P1-7 shard 03 §4: the durations move
 * inside the window; the timeline's clock is not borrowed).
 */
export function useSubwindowClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

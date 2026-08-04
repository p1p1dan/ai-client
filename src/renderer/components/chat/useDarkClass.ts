import { useSyncExternalStore } from 'react';

/**
 * T-29: "is the app currently dark?", read from the one place that actually
 * decides it.
 *
 * ## Why the class, and not the settings store
 *
 * `stores/settings/index.ts`'s `applyAppTheme` is the sole authority: it folds
 * FOUR settings states (`light` / `dark` / `system` / `sync-terminal`) into a
 * single `documentElement.classList.toggle('dark', isDark)`, and two of those
 * four are not readable from the `theme` field alone — `system` needs the media
 * query, `sync-terminal` needs `isTerminalThemeDark(terminalTheme)`.
 *
 * Re-deriving that switch in a consumer is how it drifts, and there is already
 * a live example: `ui/code-block.tsx:92-99` maps `sync-terminal` to dark
 * UNCONDITIONALLY, so a light terminal theme gives that component a dark code
 * block on a light UI. Reading the applied class cannot drift, because it is
 * the same bit the rest of the stylesheet cascades off.
 *
 * ## Why `useSyncExternalStore`
 *
 * The class is mutated imperatively from outside React (by the settings store,
 * and again by `lib/ghosttyTheme.ts`), so there is no render that observes it.
 * `useSyncExternalStore` with one process-wide `MutationObserver` gives every
 * consumer a consistent snapshot with a single subscription and no
 * effect-then-setState double render on mount.
 */

const DARK_CLASS = 'dark';

/** Pure half, so the "what counts as dark" rule is assertable without a DOM. */
export function readDarkClass(root: Element | null | undefined): boolean {
  return root?.classList.contains(DARK_CLASS) ?? false;
}

let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/**
 * Reads the DOM on every call rather than serving a cached value. That is the
 * correct shape here precisely because the snapshot is a PRIMITIVE: React
 * compares with `Object.is`, so a fresh read cannot loop, and caching would
 * re-introduce the mount-order hazard (the class is applied by the settings
 * store, which may run before or after this module is first evaluated).
 */
function getSnapshot(): boolean {
  return readDarkClass(document.documentElement);
}

/**
 * `getServerSnapshot` is required by React 19 whenever a component using this
 * hook could be hydrated. This app never server-renders, so the value only has
 * to be a stable primitive.
 */
function getServerSnapshot(): boolean {
  return false;
}

export function useDarkClass(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

interface UnmountableRoot {
  unmount(): void;
}

/**
 * Defer imperative React root unmounts out of the current commit.
 *
 * React 19 flushes passive effects while the commit context is still active, so
 * calling `root.unmount()` inside an effect body or an effect cleanup triggers the
 * "Attempted to synchronously unmount a root while React was already rendering" warning.
 * Callers should null their refs and remove Monaco widgets synchronously, then hand the
 * detached roots to this helper.
 *
 * `schedule` is injectable for tests; it defaults to `queueMicrotask`, which runs right
 * after the current commit finishes.
 */
export function deferRootUnmount(
  roots: ReadonlyArray<UnmountableRoot | null | undefined>,
  schedule: (cb: () => void) => void = queueMicrotask
): void {
  const pending = roots.filter((root): root is UnmountableRoot => root != null);
  if (pending.length === 0) return;

  schedule(() => {
    for (const root of pending) {
      try {
        root.unmount();
      } catch {
        // Root may already be unmounted or its container detached
      }
    }
  });
}

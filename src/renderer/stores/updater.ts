import type { UpdateStatus } from '@shared/types/updater';
import { useEffect } from 'react';
import { create } from 'zustand';

export const useUpdaterStore = create<{ status: UpdateStatus | null }>(() => ({ status: null }));
let subscribers = 0;
let unsubscribe: (() => void) | undefined;
let revision = 0;

export function subscribeUpdater(): () => void {
  if (subscribers++ === 0) {
    const snapshotRevision = ++revision;
    unsubscribe = window.electronAPI.updater.onStatus((status) => {
      revision++;
      useUpdaterStore.setState({ status });
    });
    void window.electronAPI.updater
      .getStatus()
      .then((status) => {
        if (revision === snapshotRevision) useUpdaterStore.setState({ status });
      })
      .catch((error: unknown) => {
        if (revision === snapshotRevision)
          useUpdaterStore.setState({
            status: {
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            },
          });
      });
  }
  return () => {
    if (--subscribers === 0) {
      revision++;
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}

export function useUpdaterStatus(): UpdateStatus | null {
  useEffect(subscribeUpdater, []);
  return useUpdaterStore((state) => state.status);
}

import { UPDATE_DOWNLOAD_STALLED, type UpdateStatus } from '@shared/types/updater';
import { useEffect } from 'react';
import { create } from 'zustand';

export const useUpdaterStore = create<{ status: UpdateStatus | null; reminderHidden: boolean }>(
  () => ({ status: null, reminderHidden: false })
);
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

/**
 * Hides the corner reminder until the app restarts (decision 213). Nothing is
 * remembered across launches, and there is no skipping of a version.
 */
export function hideUpdateReminder(): void {
  useUpdaterStore.setState({ reminderHidden: true });
}

/** A manual check from Settings brings the reminder back. */
export function showUpdateReminder(): void {
  useUpdaterStore.setState({ reminderHidden: false });
}

/** The error line of an update status; the watchdog's own message is translated. */
export function updateErrorText(
  error: string | undefined,
  t: (key: string) => string
): string | undefined {
  return error === UPDATE_DOWNLOAD_STALLED ? t(error) : error;
}

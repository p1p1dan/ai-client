export interface UpdateStatus {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported';
  info?: { version: string; releaseNotes?: string };
  progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
  error?: string;
}

/**
 * The `error` of a download the stall watchdog stopped (decision 213). It is
 * also the i18n key the renderer translates it by; the five minutes match
 * `DOWNLOAD_STALL_MS` in the main process.
 */
export const UPDATE_DOWNLOAD_STALLED =
  'The download made no progress for 5 minutes and was stopped.';

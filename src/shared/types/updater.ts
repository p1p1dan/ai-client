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

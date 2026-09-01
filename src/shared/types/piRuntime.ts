export type PiRuntimeKind = 'unavailable' | 'ready' | 'detection-failed';

export interface PiRuntimeStatus {
  kind: PiRuntimeKind;
  workerVersion?: string;
  error?: string;
}

/**
 * Payload broadcast on IPC_CHANNELS.VFLOW_PROJECT_INITIALIZED.
 *
 * Emitted by the main process after VflowService successfully runs `vflow init`
 * in a working directory that previously had no `.vflow/`. The renderer uses
 * this to surface a toast confirming the workflow scaffolding landed.
 */
export interface VflowProjectInitializedEvent {
  /** Absolute path of the project that just received `.vflow/`. */
  cwd: string;
}

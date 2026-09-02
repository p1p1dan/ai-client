import type { SessionEffortLevel } from './agentHost';

/** Pi-only options for a one-shot, tool-free completion. */
export interface CommonAISettings {
  /** Full Pi provider/model identity, or omitted to use Pi's configured default. */
  model?: string;
  /** Shared Pi thinking level. */
  effort?: SessionEffortLevel;
}

export type CommonAICompletionOptions = CommonAISettings;

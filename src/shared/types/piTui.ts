export type PiTuiOpenRequest = {
  terminalId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  initialPrompt?: string;
  /**
   * Q17: absolute path to the chat session's durable JSONL (the index row's
   * `runtimeIdentity`). Present when the terminal continues an existing chat —
   * the TUI then runs `pi --session <file>` on that same conversation, and
   * takes interactive ownership of it. Absent for a terminal opened from a
   * repo with no chat behind it, which starts a fresh Pi session.
   */
  sessionFile?: string;
};

export type PiTuiOpenResult = {
  terminalId: string;
  generation: number;
  resumed: boolean;
};

export type PiTuiStatus = {
  terminalIds: string[];
};

export type PiTuiDataEvent = { terminalId: string; data: string };
export type PiTuiExitEvent = {
  terminalId: string;
  exitCode: number;
  signal?: number;
  /** Q17: the JSONL this terminal owned, so Main can release the guard on exit. */
  sessionFile?: string;
};
export type PiTuiStatusEvent = { terminalId: string; state: 'live' | 'suspended' | 'dead' };

export type PiTuiLaunchLayout = {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform: NodeJS.Platform;
  electronExecPath: string;
};

export type PiTuiLaunchPlan = {
  cliPath: string;
  nodePath: string;
  args: string[];
  env: Record<string, string>;
  useElectronNode: boolean;
};

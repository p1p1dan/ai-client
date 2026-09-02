export type PiTuiOpenRequest = {
  terminalId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  initialPrompt?: string;
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
export type PiTuiExitEvent = { terminalId: string; exitCode: number; signal?: number };
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

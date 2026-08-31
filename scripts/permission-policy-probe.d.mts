export interface PermissionManagerProbe {
  PermissionManager: new (
    options?: Record<string, unknown>
  ) => {
    configureForCwd: (cwd: string | undefined | null) => void;
    check: (
      intent: unknown,
      sessionRules?: unknown
    ) => {
      state: 'allow' | 'ask' | 'deny';
      origin?: string;
      matchedPattern?: string;
      [key: string]: unknown;
    };
    getConfigIssues: (agentName?: string) => string[];
  };
  AccessPath: {
    forPath: (
      pathValue: string,
      options: { cwd: string; resolveBase?: string; flavor: unknown }
    ) => {
      matchValues: () => string[];
      boundaryValue: () => string;
      value: () => string;
      resolvedAlias: () => string | undefined;
    };
  };
  posixPathFlavor: unknown;
  cleanup: () => void;
}

export function loadPermissionManagerProbe(hostRoot: string): Promise<PermissionManagerProbe>;

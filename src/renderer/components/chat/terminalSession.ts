export interface TerminalSession {
  id: string;
  backendSessionId?: string;
  name: string;
  agentId: 'pi';
  initialized: boolean;
  activated?: boolean;
  repoPath: string;
  cwd: string;
  displayOrder?: number;
  terminalTitle?: string;
  userRenamed?: boolean;
  pendingCommand?: string;
}

import type { TerminalSession as Session } from '@/components/chat/terminalSession';

export function createSession(repoPath: string, cwd: string): Session {
  const id = crypto.randomUUID();
  return {
    id,
    name: 'Pi',
    agentId: 'pi',
    initialized: false,
    repoPath,
    cwd,
  };
}

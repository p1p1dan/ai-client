import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * dsh-rebase P1-7b (decisions 109, 119): the wiring a render cannot see.
 * Every piece below passes its own tests while nothing draws it — the state
 * P1-7a's strips were pinned against too. Comments are stripped first so the
 * scans read code, not the notes that name it.
 */

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (relative: string) =>
  stripComments(readFileSync(path.join(ROOT, relative), 'utf8'), relative);

describe('P1-7b wiring (jobs window, subagents window, live output)', () => {
  it('[P7B-WIRE-PRELOAD] the preload exposes the three window calls on their own channels', () => {
    const preload = read('preload/index.ts');
    expect(preload).toMatch(/killSessionJob:[\s\S]{0,200}IPC_CHANNELS\.CHAT_KILL_SESSION_JOB/);
    expect(preload).toMatch(/readSessionJob:[\s\S]{0,260}IPC_CHANNELS\.CHAT_READ_SESSION_JOB/);
    expect(preload).toMatch(/interruptSubagent:[\s\S]{0,200}IPC_CHANNELS\.CHAT_INTERRUPT_SUBAGENT/);
  });

  it('[P7B-WIRE-MAIN] Main claims the session for a kill and an interrupt, never for a read', () => {
    const chat = read('main/ipc/chat.ts');
    const handler = (channel: string) => {
      const start = chat.indexOf(`IPC_CHANNELS.${channel},`);
      expect(start, channel).toBeGreaterThan(-1);
      return chat.slice(start, chat.indexOf('ipcMain.handle(', start + 1));
    };
    expect(handler('CHAT_KILL_SESSION_JOB')).toContain(
      'claimSessionForSender(e, payload.sessionId)'
    );
    expect(handler('CHAT_KILL_SESSION_JOB')).toContain('workerManager.killSessionJob(');
    expect(handler('CHAT_INTERRUPT_SUBAGENT')).toContain(
      'claimSessionForSender(e, payload.sessionId)'
    );
    expect(handler('CHAT_INTERRUPT_SUBAGENT')).toContain('workerManager.interruptSubagent(');
    expect(handler('CHAT_READ_SESSION_JOB')).not.toContain('claimSessionForSender');
    expect(handler('CHAT_READ_SESSION_JOB')).toContain('workerManager.readSessionJob(');
  });

  it('[P7B-WIRE-WORKSPACE] the windows float over the timeline’s room; the live-output store is owned here', () => {
    const workspace = read('renderer/components/chat/ChatWorkspace.tsx');
    expect(workspace).toMatch(/<SubwindowRegion sessionId=\{activeSessionId\}>\s*<MessageTimeline/);
    expect(workspace).toMatch(
      /<SubwindowRegion sessionId=\{activeSessionId\}>\s*<div className=\{START_SCREEN_HOST_CLASS\}>/
    );
    expect(workspace).toContain('useToolLiveOutputStore.getState().init()');
    // The layer sits above the strips and the composer, never over them.
    expect(workspace.indexOf('<SubwindowRegion')).toBeLessThan(
      workspace.indexOf('<SessionPanelStrips')
    );
  });

  it('[P7B-WIRE-BAR] the session bar opens and hides both windows', () => {
    const bar = read('renderer/components/workspace-shell/SessionBar.tsx');
    expect(bar).toContain('<BackgroundWorkButtons sessionId={activeSessionId} />');
    expect(bar).toContain("toggle('jobs')");
    expect(bar).toContain("toggle('agents')");
  });

  it('[P7B-WIRE-ROWS] a running row shows its live tail; a delegation row can be located', () => {
    const rows = read('renderer/components/chat/ToolRows.tsx');
    expect(rows).toContain(
      '{view.running && view.toolCallId && <LiveToolOutput toolCallId={view.toolCallId} />}'
    );
    expect(rows).toContain('data-tool-call-id={view.toolCallId}');
  });

  it('[P7B-WIRE-PRUNE] the new session-scoped stores are pruned with the rest', () => {
    const lifecycle = read('renderer/stores/sessionLifecycle.ts');
    expect(lifecycle).toContain('useToolLiveOutputStore.getState().pruneSessions(sessionIds)');
    expect(lifecycle).toContain('useSessionSubwindowsStore.getState().pruneSessions(sessionIds)');
  });
});

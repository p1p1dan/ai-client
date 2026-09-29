import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../renderer/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-11 (decisions 109, 126, 127): the product ships no pi TUI.
 *
 * What went: the embedded pi CLI terminal and its IPC (`piTui:*`), the GUI /
 * TUI switch on the session bar, the `presentationMode` setting, the handover
 * a GUI write ran first (`handOverFromTui`) and the reload channel it needed
 * (`chat:reloadSession`), the `/new` session sweep, the vault-to-`auth.json`
 * resync the TUI read keys from, and the pi CLI plugin manager (`piPlugins:*`),
 * whose extensions only the TUI loaded. Nothing in the product launches the pi
 * CLI any more.
 *
 * What stays, and what the right-column shell terminal (decisions 126, 128)
 * is built from: the generic PTY stack (`PtyManager`, `SessionManager`,
 * `session:*` IPC), `useXterm`, `ShellTerminal`, the terminal theme settings
 * and the worktree init script, which never depended on the TUI. The last
 * block below pins that they are still here, and that the column terminal
 * runs on them rather than on anything the TUI left behind.
 *
 * Code only: comments are blanked first, so the prose that explains a removal
 * (like this one) cannot fail the scan, and prose alone cannot satisfy it.
 */

const SHARED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);
const PRODUCT_ROOTS = ['main', 'preload', 'renderer', 'shared'];

function repoRelative(file: string): string {
  return path.relative(REPO, file).split(path.sep).join('/');
}

function productFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const entry = path.join(dir, name);
    if (statSync(entry).isDirectory()) productFiles(entry, found);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) found.push(entry);
  }
  return found;
}

const FILES = PRODUCT_ROOTS.flatMap((root) => productFiles(path.join(SRC, root)));
const CODE = new Map(
  FILES.map((file) => [repoRelative(file), stripComments(readFileSync(file, 'utf8'), file)])
);

function filesContaining(needle: string | RegExp): string[] {
  return [...CODE]
    .filter(([, code]) => (typeof needle === 'string' ? code.includes(needle) : needle.test(code)))
    .map(([file]) => file)
    .sort();
}

describe('P1-11 · the product has no pi TUI', () => {
  it('walks the real product tree', () => {
    // A walker that visited nothing would report "no hits" for the wrong reason.
    expect(CODE.size).toBeGreaterThan(500);
    expect(CODE.has('src/main/ipc/chat.ts')).toBe(true);
    expect(CODE.has('src/renderer/components/workspace-shell/SessionBar.tsx')).toBe(true);
  });

  it('deleted the TUI service, IPC, views and the pi CLI plugin manager', () => {
    for (const gone of [
      'src/main/ipc/piTui.ts',
      'src/main/services/terminal/PiTuiPty.ts',
      'src/main/services/terminal/piTuiSession.ts',
      'src/main/services/terminal/piTuiStrandedSessions.ts',
      'src/main/services/agent-host/piCliLayout.ts',
      'src/shared/types/piTui.ts',
      'src/renderer/components/chat/AgentTerminal.tsx',
      'src/renderer/components/chat/usePresentationSwitch.ts',
      'src/renderer/hooks/piTuiOpenError.ts',
      'src/renderer/stores/settings/presentationModeMirror.ts',
      'src/main/ipc/piPlugins.ts',
      'src/main/services/piPlugins',
      'src/shared/piPlugins.ts',
      'src/renderer/components/settings/PiPluginsSettings.tsx',
    ]) {
      expect(existsSync(path.join(REPO, gone)), gone).toBe(false);
    }
  });

  it('exposes no TUI, reload or pi-plugin channel', () => {
    for (const token of [
      'piTui',
      'PiTui',
      'PI_TUI_',
      'CHAT_RELOAD_SESSION',
      'chat:reloadSession',
      'reloadSession(',
      'handOverFromTui',
      'releaseSessionForHostPrompt',
      'PI_PLUGINS_',
      'piPlugins:',
      'electronAPI.piPlugins',
    ]) {
      expect(filesContaining(token), token).toEqual([]);
    }
  });

  it('never launches the pi CLI: no path to it, no PTY running it', () => {
    // The TUI spawned `<pi-coding-agent>/dist/bundle/cli.js` in node-pty and
    // the plugin manager ran the same file for install/remove/list.
    expect(filesContaining("'pi-coding-agent'")).toEqual([]);
    expect(filesContaining('resolvePiCliLaunchPlan')).toEqual([]);
    expect(filesContaining('resolveManagedPiPtyEnv')).toEqual([]);
    expect(filesContaining(/['"]--session['"]/)).toEqual([]);
    // node-pty is still here — for shells and the remote helper only.
    expect(filesContaining(/from 'node-pty'|require\('node-pty'\)/)).toEqual([
      'src/main/services/remote/RemoteConnectionManager.ts',
      'src/main/services/remote/RemoteServerSource.ts',
      'src/main/services/terminal/PtyManager.ts',
      'src/main/utils/shell.ts',
    ]);
  });

  it('has no GUI / TUI switch and no presentation mode', () => {
    const bar = CODE.get('src/renderer/components/workspace-shell/SessionBar.tsx') ?? '';
    expect(bar).not.toMatch(/['"`>]\s*TUI\s*['"`<]/);
    expect(bar).not.toContain('Presentation mode');
    expect(bar).not.toContain('openTui');
    expect(filesContaining('presentationMode')).toEqual([
      // Only as a key to strip from old profiles (decision 127).
      'src/renderer/stores/settings/migration.ts',
    ]);
    expect(filesContaining('setPresentationMode')).toEqual([]);
    expect(filesContaining('usePresentationSwitch')).toEqual([]);
    expect(filesContaining('AgentTerminal')).toEqual([]);
  });

  it('writes no plaintext auth.json and keeps no vault resync for it', () => {
    const service = CODE.get('src/main/services/piModelConfig/PiModelConfigService.ts') ?? '';
    expect(service).not.toMatch(/atomicWriteJson\(\s*this\.authPath/);
    // Logout may still take away a copy an older build left (decision 127).
    expect(service).toMatch(/unlinkSync\(this\.authPath\)/);
    expect(filesContaining('wireVaultAuthJsonResync')).toEqual([]);
  });

  it('keeps the generic terminal stack, which the right-column shell runs on', () => {
    for (const kept of [
      'src/main/services/terminal/PtyManager.ts',
      'src/main/services/session/SessionManager.ts',
      'src/main/ipc/session.ts',
      'src/renderer/hooks/useXterm.ts',
      'src/renderer/components/terminal/ShellTerminal.tsx',
      'src/renderer/components/terminal/TerminalPanel.tsx',
      'src/renderer/stores/initScript.ts',
    ]) {
      expect(existsSync(path.join(REPO, kept)), kept).toBe(true);
    }
    const xterm = CODE.get('src/renderer/hooks/useXterm.ts') ?? '';
    expect(xterm).toContain('window.electronAPI.session.create(');
    expect(xterm).toContain('window.electronAPI.session.write(');
    // The worktree init script runs in the shell terminal surface, not a TUI
    // (decision 128 item 17 keeps it there).
    const worktree = CODE.get('src/renderer/hooks/useWorktree.ts') ?? '';
    expect(worktree).toContain('openInitializationTerminal()');
  });

  it('opens the session bar terminal as a plain shell in the right column (decision 128)', () => {
    const column =
      CODE.get('src/renderer/components/workspace-shell/center/TerminalColumn.tsx') ?? '';
    expect(column).toContain('<ShellTerminal');
    expect(column).not.toMatch(/command=|kind=/);
    const shell = CODE.get('src/renderer/components/workspace-shell/WorkspaceShell.tsx') ?? '';
    expect(shell).toContain('<TerminalColumn');
    const bar = CODE.get('src/renderer/components/workspace-shell/SessionBar.tsx') ?? '';
    expect(bar).toContain('<TerminalButton state={terminalState} onToggle={onToggleTerminal} />');
    // No PTY kind but a shell is left: the agent value went with the TUI.
    expect(CODE.get('src/shared/types/session.ts')).toContain(
      "export type SessionKind = 'terminal';"
    );
    expect(CODE.get('src/renderer/hooks/useXterm.ts')).not.toContain('kind?:');
  });
});

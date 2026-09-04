import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * U05-b / U03-b — the wiring that lets a chat with no folder actually run.
 *
 * The pure decisions are unit-tested elsewhere (`chatEmptyState.test.ts` for
 * the surface, `middleColumnLayout.test.ts` for the placeholder,
 * `stores/__tests__/scratchWorkspace.test.ts` for the allocation). What those
 * cannot reach is whether the composer and the workspace still block on a null
 * `cwd` in their own JSX and guard expressions — which is precisely where the
 * old block lived, and where deleting the new code leaves every other test
 * green.
 *
 * Comments are stripped first, so a scan cannot be satisfied by the prose that
 * explains it.
 */

const COMPOSER = stripComments(
  readFileSync(path.join(__dirname, '..', 'ChatComposer.tsx'), 'utf8'),
  'ChatComposer.tsx'
);
const WORKSPACE = stripComments(
  readFileSync(path.join(__dirname, '..', 'ChatWorkspace.tsx'), 'utf8'),
  'ChatWorkspace.tsx'
);

describe('[U05-b] the composer can send without a bound folder', () => {
  it('treats "session with no cwd" as unbound rather than unusable', () => {
    expect(COMPOSER).toContain('const isUnboundSession = Boolean(activeSessionId) && cwd === null');
  });

  it('admits an unbound chat through the send gate', () => {
    expect(COMPOSER).toMatch(/const canSend = Boolean\([^)]*isUnboundSession[^)]*\)/);
  });

  it('no longer bails out of runSend on a null cwd', () => {
    // The single line that made a folderless install unable to talk at all.
    expect(COMPOSER).not.toContain('if (!canSend || !activeSessionId || !cwd)');
  });

  it('allocates the isolated directory inside the send handshake', () => {
    // Position matters: inside the try that already owns `ensureHost`, so an
    // allocation failure is reported and the draft preserved by the same
    // `finalizeOutcome` path every other handshake failure uses.
    expect(COMPOSER).toMatch(
      /await window\.electronAPI\.chat\.ensureHost\(\);\s*if \(!workspacePath\) \{[\s\S]{0,600}useScratchWorkspaceStore\.getState\(\)\.ensure\(sessionId\)/
    );
  });

  it('never hands an empty workspacePath to createSession', () => {
    // `workspacePath` starts empty for an unbound chat, and the guard asserted
    // above is the only thing that fills it before the IPC call below.
    expect(COMPOSER).toContain("let workspacePath = cwd ?? ''");
    expect(COMPOSER).toMatch(/createSession\(\{\s*sessionId,\s*workspacePath,/);
  });

  it('reads the scratch directory for cwd-dependent features', () => {
    // @-file search, the status line and the TUI must all name the directory
    // the agent is actually in, not the folder the chat does not have.
    expect(COMPOSER).toContain('const effectiveCwd = cwd ?? scratchCwd');
    expect(COMPOSER).toContain('rootPath: effectiveCwd');
  });
});

describe('[U05-b] the workspace shows the temporary marker and keeps the welcome path', () => {
  it('marks an unbound chat in the header', () => {
    expect(WORKSPACE).toMatch(/isUnboundSession && \([\s\S]{0,400}Temporary/);
  });

  it('still renders the header bar for a chat with no folder', () => {
    // The bar carries the GUI/TUI switch. Gating it on `activeWorkspacePath`
    // alone would leave an unbound chat with no way into the TUI at all.
    expect(WORKSPACE).toContain('{(activeWorkspacePath || isUnboundSession) && (');
  });
});

describe('[U03-b] the Pi TUI runs in the isolated directory', () => {
  it('gates the TUI on a usable cwd, not on a bound folder', () => {
    expect(WORKSPACE).not.toContain("presentationMode === 'tui' && activeWorkspacePath");
    expect(WORKSPACE).toContain("presentationMode === 'tui' && effectiveCwd");
  });

  it('passes that same directory to the terminal', () => {
    // The acceptance criterion with teeth: the TUI's cwd is the session's own
    // isolated directory, never a fallback to the process cwd.
    expect(WORKSPACE).toMatch(/<AgentTerminal[\s\S]{0,200}cwd=\{effectiveCwd\}/);
  });

  it('allocates the directory before switching into TUI mode', () => {
    expect(WORKSPACE).toMatch(/ensureScratchWorkspace\(activeSessionId\)\.then\(start/);
  });

  it('reports an allocation failure instead of opening a TUI with no directory', () => {
    expect(WORKSPACE).toMatch(/ensureScratchWorkspace\(activeSessionId\)[\s\S]{0,400}addToast\(/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../chat/__tests__/stripComments';

/**
 * Adversarial review batch B, editor intent chain.
 *
 * `EditorSurfaceView.tsx` transitively imports `EditorArea` → Monaco's
 * `monacoSetup` (`self.MonacoEnvironment`, worker imports, a top-level
 * `await loader.init()`), so it cannot be `import`ed under vitest's `node`
 * test environment — same constraint `terminalSurfaceStatic.test.ts` works
 * around for `TerminalSurfaceView.tsx`/xterm. This suite follows that same
 * static-scan pattern: read the source, strip comments, and assert on the
 * flattened text instead of executing it. The two exported pure decision
 * functions this batch adds (`gateFileOpenIntent`,
 * `isNavigationIntentStillValid`) are simple boolean/enum logic pinned here
 * by presence + branch-name checks; `useEditor.test.ts` covers the one pure
 * function that IS safely importable (`isNavigationRequestAborted`).
 */

const ROOT = process.cwd();

function code(relativePath: string): { raw: string; flat: string } {
  const file = join(ROOT, relativePath);
  const raw = readFileSync(file, 'utf8');
  // Whitespace-flattened so the assertions survive any re-formatting.
  return { raw, flat: stripComments(raw, file).replace(/\s+/g, ' ') };
}

const VIEW = code('src/renderer/components/workspace-shell/surfaces/EditorSurfaceView.tsx');

describe('EditorSurfaceView holds Escape for the whole surface subtree (M6)', () => {
  it('spreads ESCAPE_HOLD_PROPS exactly once', () => {
    const matches = VIEW.flat.match(/\{\.\.\.ESCAPE_HOLD_PROPS\}/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('spreads it on the ref={containerRef} root, not the editor-only pane', () => {
    expect(VIEW.flat).toContain(
      'ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col" {...ESCAPE_HOLD_PROPS}'
    );
    // The old duplicate on the editor pane div must be gone.
    expect(VIEW.flat).not.toContain(
      'className="h-full min-h-0 min-w-0 flex-1" {...ESCAPE_HOLD_PROPS}'
    );
  });
});

describe('EditorSurfaceView fileOpenIntent gate (m12)', () => {
  it('defines a three-way gate instead of only checking "needsWorkspace"', () => {
    expect(VIEW.flat).toContain('function gateFileOpenIntent(');
    expect(VIEW.flat).toContain("gate === 'wait'");
    expect(VIEW.flat).toContain("gate === 'blocked'");
  });

  it('does not navigate for an absolute-path intent when rootPath is null — notices and acks instead', () => {
    expect(VIEW.flat).toContain("setIntentNotice(t('Select a Workspace to browse files'))");
    // Reuses the SAME key the empty-state branch already uses — no new i18n key.
    const noticeKeyUses = VIEW.flat.match(/t\('Select a Workspace to browse files'\)/g) ?? [];
    expect(noticeKeyUses).toHaveLength(2);
  });

  it('acks the request in every terminal branch (blocked / unresolved / settled) so it never replays', () => {
    const acks =
      VIEW.flat.match(/useFileOpenIntentStore\.getState\(\)\.ackFileOpen\(requestId\)/g) ?? [];
    expect(acks).toHaveLength(3);
  });
});

describe('EditorSurfaceView intent-consumption race guard (Codex major)', () => {
  it('defines the pure stillValid decision function', () => {
    expect(VIEW.flat).toContain('export function isNavigationIntentStillValid(');
  });

  it('passes a stillValid guard INTO navigateToFile, not just a post-hoc .then() cancelled check', () => {
    expect(VIEW.flat).toContain('const stillValid = () =>');
    expect(VIEW.flat).toContain('stillValid,');
    expect(VIEW.flat).toMatch(/navigateToFile\([^)]*\{\s*stillValid,?\s*\}\)/);
  });

  it('re-derives requestId and rootPath from LIVE store state, not the closed-over render values', () => {
    expect(VIEW.flat).toContain(
      'liveIntentRequestId: useFileOpenIntentStore.getState().intent?.requestId ?? null'
    );
    expect(VIEW.flat).toContain('liveRootPath: resolveLiveWorkspaceRootPath()');
    expect(VIEW.flat).toContain('function resolveLiveWorkspaceRootPath(');
  });

  it('still checks cancelled in the .then() for the notice/ack half of the flow (unrelated to the openFile race)', () => {
    expect(VIEW.flat).toContain('if (cancelled) return;');
  });
});

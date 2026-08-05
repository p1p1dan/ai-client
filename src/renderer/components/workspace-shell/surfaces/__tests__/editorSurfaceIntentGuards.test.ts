import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../chat/__tests__/stripComments';

/**
 * Adversarial review batch B (T-13), editor intent chain — **re-pointed by
 * T-32 S3, guarantees unchanged**.
 *
 * The chain used to live in one `EditorSurfaceView.tsx`. D27/#28 ① split it
 * across two columns: the tree half is `surfaces/FilesSurfaceView.tsx`, the
 * editor + intent half is `center/EditorColumn.tsx`. Every pin below still
 * asserts exactly what it asserted before; only the file it reads changed, and
 * the Escape-hold count is now "once per subtree" across two files instead of
 * once in one (R4: these tests move, they do not relax).
 *
 * Both files transitively reach Monaco's `monacoSetup` (`self.MonacoEnvironment`,
 * worker imports, a top-level `await loader.init()`), so they cannot be
 * `import`ed under vitest's `node` environment — same constraint
 * `terminalSurfaceStatic.test.ts` works around for xterm. Hence the static
 * scan: read the source, strip comments, assert on flattened text.
 * `useEditor.test.ts` covers the one pure function that IS safely importable
 * (`isNavigationRequestAborted`).
 */

const ROOT = process.cwd();

function code(relativePath: string): { raw: string; flat: string } {
  const file = join(ROOT, relativePath);
  const raw = readFileSync(file, 'utf8');
  // Whitespace-flattened so the assertions survive any re-formatting.
  return { raw, flat: stripComments(raw, file).replace(/\s+/g, ' ') };
}

const EDITOR = code('src/renderer/components/workspace-shell/center/EditorColumn.tsx');
const FILES = code('src/renderer/components/workspace-shell/surfaces/FilesSurfaceView.tsx');

describe('Escape is held for both halves of the split subtree (M6)', () => {
  it('each half spreads ESCAPE_HOLD_PROPS exactly once', () => {
    // One per column: Monaco's find/suggest own Escape in the editor, and
    // FileTree's rename input owns it in the panel. A half that forgot it
    // would have the panel's capture-phase handler eat the key again.
    expect(EDITOR.flat.match(/\{\.\.\.ESCAPE_HOLD_PROPS\}/g) ?? []).toHaveLength(1);
    expect(FILES.flat.match(/\{\.\.\.ESCAPE_HOLD_PROPS\}/g) ?? []).toHaveLength(1);
  });

  it('spreads it on each half`s ROOT element, not an inner pane', () => {
    expect(EDITOR.flat).toContain(
      'className="flex h-full min-h-0 min-w-0 flex-col border-l" {...ESCAPE_HOLD_PROPS}'
    );
    expect(FILES.flat).toContain(
      'className="flex h-full min-h-0 min-w-0 flex-col" {...ESCAPE_HOLD_PROPS}'
    );
  });
});

describe('EditorColumn fileOpenIntent gate (m12)', () => {
  it('defines a three-way gate instead of only checking "needsWorkspace"', () => {
    expect(EDITOR.flat).toContain('function gateFileOpenIntent(');
    expect(EDITOR.flat).toContain("gate === 'wait'");
    expect(EDITOR.flat).toContain("gate === 'blocked'");
  });

  it('does not navigate for an absolute-path intent when rootPath is null — notices and acks instead', () => {
    expect(EDITOR.flat).toContain("setIntentNotice(t('Select a Workspace to browse files'))");
    // Still the SAME i18n key the (now relocated) empty state uses — the
    // split moved that empty state to FilesSurfaceView, so the key now
    // appears once in each file rather than twice in one.
    expect(EDITOR.flat.match(/t\('Select a Workspace to browse files'\)/g) ?? []).toHaveLength(1);
    expect(FILES.flat.match(/t\('Select a Workspace to browse files'\)/g) ?? []).toHaveLength(1);
  });

  it('acks the request in every terminal branch (blocked / unresolved / settled) so it never replays', () => {
    const acks =
      EDITOR.flat.match(/useFileOpenIntentStore\.getState\(\)\.ackFileOpen\(requestId\)/g) ?? [];
    expect(acks).toHaveLength(3);
  });
});

describe('EditorColumn intent-consumption race guard (Codex major)', () => {
  it('defines the pure stillValid decision function', () => {
    expect(EDITOR.flat).toContain('export function isNavigationIntentStillValid(');
  });

  it('passes a stillValid guard INTO navigateToFile, not just a post-hoc .then() cancelled check', () => {
    expect(EDITOR.flat).toContain('const stillValid = () =>');
    expect(EDITOR.flat).toContain('stillValid,');
    expect(EDITOR.flat).toMatch(/navigateToFile\([^)]*\{\s*stillValid,?\s*\}\)/);
  });

  it('re-derives requestId and rootPath from LIVE store state, not the closed-over render values', () => {
    expect(EDITOR.flat).toContain(
      'liveIntentRequestId: useFileOpenIntentStore.getState().intent?.requestId ?? null'
    );
    // T-32: the live re-read moved into the shared `useWorkspaceRootPath`
    // module (both columns must agree on the workspace); the guarantee — a
    // NON-reactive read, not the closed-over render value — is unchanged.
    expect(EDITOR.flat).toContain('liveRootPath: readWorkspaceRootPath()');
    expect(EDITOR.flat).toContain('readWorkspaceRootPath');
  });

  it('still checks cancelled in the .then() for the notice/ack half of the flow', () => {
    expect(EDITOR.flat).toContain('if (cancelled) return;');
  });
});

describe('T-32 split invariants', () => {
  it('per-workspace tab isolation lives in the column that owns the tabs', () => {
    expect(EDITOR.flat).toContain('switchWorktree(');
    // Two callers would race each other on a workspace switch.
    expect(FILES.flat).not.toContain('switchWorktree(');
  });

  it('the editor column costs no box when nothing is open', () => {
    // The shell keys the whole center column off "has tabs"; a stray wrapper
    // here would leave a border and a flex slot on an empty screen.
    expect(EDITOR.flat).toContain('if (tabs.length === 0 || !rootPath) { return null; }');
  });

  it('a tree click opens the CENTER editor rather than a panel-local tab (a08:1512)', () => {
    expect(FILES.flat).toContain('navigateToFile(path)');
  });
});

// @vitest-environment happy-dom
/**
 * Layout 5e (ui-cohesion §6, ruling L5): while the session rail is on screen
 * the composer hides what the rail already shows — the context chip and the
 * run location under the box, the todo strip above it — and shows them again
 * the moment the rail goes (hidden by the user, a pane, a narrow window).
 * The rail's 「压缩」 reaches the composer's own `/compact` path by event.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onComposerCompactRequest, requestComposerCompact } from '../composerFocus';
import { stripComments } from './stripComments';

const read = (relative: string) => {
  const file = path.join(process.cwd(), relative);
  return stripComments(readFileSync(file, 'utf8'), file);
};

describe('the composer yields to the rail only while it shows', () => {
  it('the run location under the box (session mode)', () => {
    const bar = read('src/renderer/components/chat/ComposerTargetBar.tsx');
    expect(bar).toContain('const sessionRailPresent = useSessionRailPresent();');
    expect(bar).toContain('{slots.runLocation && runLocation && !sessionRailPresent && (');
    // Empty / home modes keep theirs: the rail is never beside them.
    expect(bar).toMatch(
      /slots\.runLocation &&\s*runLocation && <RunLocationIndicator text=\{t\(runLocation\.text\)\} tone=\{runLocation\.tone\} \/>/
    );
  });

  it('the todo strip above the box; the goal bar stays', () => {
    const strips = read('src/renderer/components/chat/SessionPanelStrips.tsx');
    expect(strips).toContain('const todo = railPresent ? null : deriveTodoCardView(panels);');
    expect(strips).toContain('const goal = deriveGoalBarView(panels, turnInFlight, dismissed);');
  });

  it('outside the shell there is no rail', () => {
    const presence = read('src/renderer/components/chat/sessionRailPresence.ts');
    expect(presence).toContain('createContext(false)');
  });
});

describe('requestComposerCompact', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reaches only the composer of the named chat', () => {
    const compactA = vi.fn();
    const compactB = vi.fn();
    const offA = onComposerCompactRequest(() => 'a', compactA);
    const offB = onComposerCompactRequest(() => 'b', compactB);
    requestComposerCompact('a');
    expect(compactA).toHaveBeenCalledTimes(1);
    expect(compactB).not.toHaveBeenCalled();
    offA();
    offB();
    requestComposerCompact('a');
    expect(compactA).toHaveBeenCalledTimes(1);
  });

  it('the composer runs it through its built-in slash path', () => {
    const composer = read('src/renderer/components/chat/ChatComposer.tsx');
    expect(composer).toContain("runBuiltinSlashRef.current('/compact')");
  });
});

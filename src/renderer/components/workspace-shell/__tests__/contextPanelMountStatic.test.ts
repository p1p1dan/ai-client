import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * S0 risk R7: static evidence that the keep-alive mount stack hides layers the
 * only way that is safe.
 *
 * `deriveMountedSurfaceIds` decides WHICH views exist; nothing pure can decide
 * HOW a hidden one is hidden, and that is the half with teeth. `visibility:
 * hidden` keeps the layout box, so a hidden layer still measures the panel's
 * real content width. `display: none`, a `hidden` class or a conditional
 * unmount all collapse it to 0x0 — and xterm's `FitAddon` runs off a
 * ResizeObserver that `useXterm` does not zero-guard, so the pty is told
 * `cols: 2` and everything running inside it re-wraps at two columns. The
 * damage is invisible in a mount-list assertion and permanent in the session,
 * which is why it is pinned here as well as in the component's own comment.
 *
 * Scans read CODE, not prose (shared parser-backed strip): the doc comment in
 * the dock has to spell the banned technique in order to explain the ban, and a
 * scanner that cannot tell the two apart would force a choice between keeping
 * the scan and keeping the explanation.
 *
 * D08: the stack moved from `ContextPanel.tsx` (the retired right column) to
 * `LeftDock.tsx`; layout 5a moved it to the work panel (`WorkPanel.tsx`);
 * layout 5d split that panel into pane cards (`PaneArea.tsx` decides what is
 * mounted, `PaneCard.tsx` how an off-screen card hides). Same mechanism, same
 * hazard, same guard — only the files changed.
 */

const DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');
const AREA_FILE = join(DIR, 'PaneArea.tsx');
const CARD_FILE = join(DIR, 'PaneCard.tsx');
const AREA_RAW = readFileSync(AREA_FILE, 'utf8');
const AREA = stripComments(AREA_RAW, AREA_FILE);
const CARD_RAW = readFileSync(CARD_FILE, 'utf8');
const CARD = stripComments(CARD_RAW, CARD_FILE);

describe('pane cards keep-alive hiding technique (layout 5d)', () => {
  it('hides off-screen cards with visibility, not layout removal', () => {
    expect(CARD).toContain('pointer-events-none invisible');
  });

  it('also marks hidden cards inert so focus and a11y skip them', () => {
    expect(CARD).toContain('inert={!shown}');
  });

  it('never uses display:none anywhere in the area or a card', () => {
    expect(AREA).not.toMatch(/display\s*:\s*['"]?\s*none/i);
    expect(CARD).not.toMatch(/display\s*:\s*['"]?\s*none/i);
  });

  it('mounts by a rule per kind, keep-alive surfaces once visited, cards keyed by kind', () => {
    expect(AREA).toContain('PANE_KINDS.filter(mounted).map((kind) => {');
    expect(AREA).toContain("SURFACE_VIEWS[surfaceId]?.mountPolicy === 'keep-alive'");
    expect(AREA).toContain('key={kind}');
  });

  it('lays a hidden card over the whole box so it still measures full size', () => {
    expect(CARD).toContain("!shown && 'pointer-events-none invisible inset-0 opacity-0'");
  });

  it('keeps the reason in the source, where the next edit will read it', () => {
    // Asserted on RAW: this one is about the comment surviving, not the code.
    expect(AREA_RAW).toContain('ResizeObserver');
    expect(AREA_RAW).toMatch(/cols:\s*2/);
    expect(CARD_RAW).toMatch(/cols:\s*2/);
  });
});

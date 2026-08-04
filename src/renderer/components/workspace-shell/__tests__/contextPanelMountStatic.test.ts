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
 * `ContextPanel.tsx` has to spell the banned technique in order to explain the
 * ban, and a scanner that cannot tell the two apart would force a choice
 * between keeping the scan and keeping the explanation.
 */

const PANEL_FILE = join(process.cwd(), 'src/renderer/components/workspace-shell/ContextPanel.tsx');
const RAW = readFileSync(PANEL_FILE, 'utf8');
const CODE = stripComments(RAW, PANEL_FILE);

describe('ContextPanel keep-alive hiding technique', () => {
  it('hides inactive layers with visibility, not layout removal', () => {
    expect(CODE).toContain('invisible pointer-events-none');
  });

  it('also marks hidden layers inert so focus and a11y skip them', () => {
    expect(CODE).toContain('inert={!visible}');
  });

  it('never uses display:none anywhere in the panel', () => {
    expect(CODE).not.toMatch(/display\s*:\s*['"]?\s*none/i);
  });

  it('drives mounting from the derived list rather than the active id alone', () => {
    expect(CODE).toContain('mountedSurfaceIds.map');
    expect(CODE).toContain('deriveMountedSurfaceIds');
  });

  it('stacks the layers over one box so a hidden one still measures full size', () => {
    expect(CODE).toContain('absolute inset-0');
  });

  it('keeps the reason in the source, where the next edit will read it', () => {
    // Asserted on RAW: this one is about the comment surviving, not the code.
    expect(RAW).toContain('ResizeObserver');
    expect(RAW).toMatch(/cols:\s*2/);
  });
});

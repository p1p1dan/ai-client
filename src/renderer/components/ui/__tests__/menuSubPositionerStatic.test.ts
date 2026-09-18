import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Locks the fix for the submenu "jump" bug: Base UI's default collision
 * avoidance for a nested submenu is "flip" on both the side and align axes,
 * so a click that re-measures the popup near a collision boundary can
 * instantly mirror it to the opposite side (right -> left) or edge
 * (top-start -> bottom-end) instead of sliding it. `MenuSubPopup` opts into
 * `shift` on both axes so a submenu only slides to stay on screen and never
 * relocates out from under the pointer.
 *
 * The root menu popup (`MenuPopup` used directly, and `TitleBarMenuPopup`)
 * deliberately keeps Base UI's own defaults: a top-level popup flipping
 * top/bottom near a screen edge is ordinary dropdown behaviour, not the bug
 * fixed here, so this suite also pins that those two were left alone.
 */

const MENU_FILE = path.join(process.cwd(), 'src/renderer/components/ui/menu.tsx');
const CODE = stripComments(readFileSync(MENU_FILE, 'utf8'), MENU_FILE);

function functionBody(name: string, nextMarker: string): string {
  const start = CODE.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = CODE.indexOf(nextMarker, start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

describe('menu submenu positioner collision avoidance', () => {
  it('MenuSubPopup shifts instead of flipping on both axes', () => {
    const body = functionBody('MenuSubPopup', 'function TitleBarMenuPopup');
    expect(body).toContain("collisionAvoidance={{ side: 'shift', align: 'shift' }}");
    // The submenu still opens off the trigger's inline-end edge; only how it
    // resolves a collision changed.
    expect(body).toContain('side="inline-end"');
  });

  it('MenuPopup forwards collisionAvoidance without hard-coding an override', () => {
    const body = functionBody('MenuPopup', 'function MenuGroup');
    expect(body).toContain('collisionAvoidance');
    expect(body).toContain('collisionAvoidance={collisionAvoidance}');
    // Root/top-level menus keep whichever default Base UI picks
    // (DROPDOWN_COLLISION_AVOIDANCE at the root, POPUP_COLLISION_AVOIDANCE
    // when nested), which is what allows the reasonable top/bottom flip
    // near a screen edge — a hard-coded object literal here would remove it.
    expect(body).not.toContain('collisionAvoidance={{');
  });

  it('TitleBarMenuPopup is left on Base UI defaults (not part of this bug)', () => {
    const body = functionBody('TitleBarMenuPopup', 'export {');
    expect(body).not.toContain('collisionAvoidance');
  });
});

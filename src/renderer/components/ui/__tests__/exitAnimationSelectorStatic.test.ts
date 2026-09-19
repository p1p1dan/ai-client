import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Locks the fix for "the menu will not close" (PERM-1, reported from the field
 * twice; root-caused 2026-09-19).
 *
 * Base UI drives its exit animation by putting `data-ending-style` ON THE
 * POPUP ELEMENT ITSELF, then waiting for that element's CSS transition to
 * finish before unmounting the popup AND its backdrop. Four components wrote
 * the hiding rule as `has-data-ending-style:opacity-0`, and Tailwind's `has-`
 * prefix compiles to `:has([data-ending-style])` — "if a DESCENDANT carries the
 * attribute". The attribute is on the element, never on a descendant, so:
 *
 *   1. the rule never matched and `opacity` stayed at 1,
 *   2. no transition ever started (`getAnimations()` was empty),
 *   3. Base UI waited forever for a `transitionend` that could not come,
 *   4. the popup AND its `fixed inset-0` backdrop stayed in the DOM, and the
 *      backdrop ate every click — the whole window went dead.
 *
 * Measured on the running app: `data-closed` and `data-ending-style` both
 * present, `opacity: 1`, `getAnimations(): []`, composer unreachable by a
 * click at its own centre point.
 *
 * `dialog.tsx`, `accordion.tsx` and `popover.tsx` had it right all along
 * (`data-ending-style:opacity-0`), which is what makes this a typo rather than
 * a misunderstanding — and why a whole-directory scan is the right guard: the
 * next component copied from the wrong neighbour would ship the same freeze.
 */

const UI_DIR = path.join(process.cwd(), 'src/renderer/components/ui');

/**
 * `has-` is legitimate for state a CHILD owns (`has-data-[slot=group]`), so the
 * ban is narrowed to the two attributes Base UI puts on the element itself.
 */
const BANNED = ['has-data-starting-style', 'has-data-ending-style'];

describe('Base UI exit-animation selectors', () => {
  const files = readdirSync(UI_DIR).filter((f) => f.endsWith('.tsx'));

  it('scans a non-trivial number of components', () => {
    // A rename or a moved directory would otherwise turn this suite green by
    // scanning nothing at all.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s does not gate its own exit animation behind has-', (file) => {
    const source = readFileSync(path.join(UI_DIR, file), 'utf8');
    for (const banned of BANNED) {
      expect(
        source.includes(banned),
        `${file} uses "${banned}:", which compiles to :has([${banned.slice(4)}]) and looks at ` +
          `DESCENDANTS. Base UI sets that attribute on this element, so the rule never matches, ` +
          `the exit transition never runs, and Base UI never unmounts the popup or its backdrop. ` +
          `Drop the "has-" prefix.`
      ).toBe(false);
    }
  });

  it('the popup components that freeze the window do hide themselves on exit', () => {
    // The positive half: a ban alone would pass on a file that simply deleted
    // the rule, which reintroduces the freeze in a different disguise.
    for (const file of ['menu.tsx']) {
      const source = readFileSync(path.join(UI_DIR, file), 'utf8');
      expect(source).toContain('data-ending-style:opacity-0');
    }
  });

  /**
   * The second, independent failure found the same day, and the reason the
   * first fix alone was not enough.
   *
   * Even with the selector corrected, Base UI did NOT unmount a closed popup,
   * its positioner, or its backdrop — measured on the running app: the
   * announcement dialog sat there at `data-closed` + `opacity: 0` with
   * `pointer-events: auto`, and a real mouse click at the composer's own centre
   * landed on it instead. Invisible, still mounted, still eating every click:
   * the window simply stopped responding, with nothing on screen to explain why.
   *
   * Whether that non-unmount is a Base UI bug or our misuse is still open. This
   * rule makes it not matter — a layer marked closed cannot take a click,
   * however long it lingers — so it must hold on every full-screen backdrop,
   * not just the one that was reported.
   */
  it('every full-screen backdrop stops taking clicks once closed', () => {
    const backdropFiles = files.filter((f) => {
      const source = readFileSync(path.join(UI_DIR, f), 'utf8');
      return /Primitive\.Backdrop|data-slot="[a-z-]*backdrop"/.test(source);
    });
    expect(backdropFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of backdropFiles) {
      const source = readFileSync(path.join(UI_DIR, file), 'utf8');
      // Count the backdrops, then the guards: one guard per backdrop, so a
      // newly added second backdrop in the same file cannot ride on the first
      // one's rule.
      // JSX elements only — `AlertDialogPrimitive.Backdrop.Props` in a type
      // annotation is not a backdrop that can swallow anything.
      const backdrops = source.match(/<\w*Primitive\.Backdrop\b/g) ?? [];
      const guards = source.match(/data-closed:pointer-events-none/g) ?? [];
      expect(
        guards.length,
        `${file} declares ${backdrops.length} backdrop(s) but only ${guards.length} ` +
          `"data-closed:pointer-events-none" guard(s). A closed backdrop that keeps ` +
          `pointer-events:auto covers the whole window and swallows every click.`
      ).toBeGreaterThanOrEqual(backdrops.length);
    }
  });
});

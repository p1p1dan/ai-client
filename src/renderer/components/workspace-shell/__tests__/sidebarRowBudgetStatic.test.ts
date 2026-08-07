import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';
import { SIDEBAR_DEFAULT_WIDTH } from '../shellLayoutModel';

/**
 * S2 (b/C14) follow-up: the sidebar session row now carries an agent chip, and
 * width is a zero-sum game on that row. This pins WHO yields when it runs out.
 *
 * The arithmetic that makes it a defect rather than a nit — an indented session
 * row at the default sidebar width:
 *
 *   280 (SIDEBAR_DEFAULT_WIDTH, == SIDEBAR_MIN_WIDTH, so this is the shipped
 *        default, not an edge case)
 *   -16 (list container `p-2`)
 *   -12 (folder children `pl-3`)
 *   -16 (row `px-2`)
 *   = 236px of row content
 *
 * Trailing items claim ~63 (agent chip) + 96 (branch chip cap) + 40 (age /
 * actions box) + gaps. `flex-1 min-w-0` on the title means it absorbs the whole
 * deficit, which left it around 16px — a bare ellipsis on every row.
 *
 * The fix is a priority order, not a pixel prediction (font metrics are not
 * knowable from here, and the row must stay correct at every width from 280 to
 * 500): the title gets a floor, the agent chip is fixed, and the branch chip is
 * the sole shrinkable item. This is a class-level scan because the ordering is
 * expressed entirely in flex classes — there is nothing pure to call, and the
 * defect is invisible to a render test that does not do layout (jsdom does not
 * implement flexbox, so a DOM assertion here would pass on the broken markup).
 *
 * Scans read CODE, not prose (shared parser-backed strip): the comments in
 * `LeftNav.tsx` have to spell out the classes in order to explain them.
 */

const NAV_FILE = join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const RAW = readFileSync(NAV_FILE, 'utf8');
const CODE = stripComments(RAW, NAV_FILE);

/** The session row's own className, isolated so sibling rows cannot satisfy a scan. */
const SESSION_ROW_CLASS =
  /'group flex h-7 w-full items-center gap-1\.5 overflow-hidden rounded-md px-2 text-left text-ui'/;

describe('sidebar session row width budget', () => {
  it('keeps the row a single h-7 line with a clipping box', () => {
    // h-7 is the design-system tree-node token; a second line would silently
    // change sidebar density instead of solving the overflow.
    expect(CODE).toMatch(SESSION_ROW_CLASS);
  });

  it('gives the title a floor so it can never collapse to a bare ellipsis', () => {
    expect(CODE).toContain('<span className="min-w-20 flex-1 truncate">{row.title}</span>');
    // The floor is the invariant. `flex-1 min-w-0` (the pre-fix shape) is the
    // exact thing that let the chips eat the title, so it must not come back.
    expect(CODE).not.toContain('min-w-0 flex-1 truncate">{row.title}');
  });

  it('pins the agent chip: never shrinks, never truncates', () => {
    // AGENT_DISPLAY_NAMES is a closed vocabulary with a known ceiling, so a
    // max-w here could only ever truncate a label that already fits.
    expect(CODE).toContain(
      '<Badge variant="outline" size="sm" className="shrink-0" title={row.agentChip.label}>'
    );
  });

  it('makes the branch chip the sole yielder', () => {
    expect(CODE).toContain('className="min-w-0 max-w-24 shrink"');
    // shrink-0 on the branch chip sends the deficit straight back to the title.
    expect(CODE).not.toMatch(/max-w-\d+ shrink-0" title=\{row\.chip\.label\}/);
  });

  it('ellipsizes the branch chip through a block child, not the inline-flex Badge', () => {
    // Badge is `inline-flex`; text-overflow does not apply to the anonymous
    // flex item that bare text becomes.
    expect(CODE).toContain('<span className="min-w-0 truncate">{row.chip.label}</span>');
  });

  it('sizes the age/actions swap to one fixed box so hovering cannot re-flow the row', () => {
    // ~21px of relative age vs 40px of icon buttons: without a shared width the
    // swap moves every other item on the row on every hover.
    expect(CODE).toContain('className="w-10 shrink-0 text-right text-meta');
    expect(CODE).toContain(
      'className="hidden w-10 shrink-0 items-center justify-end group-hover:flex group-focus-within:flex"'
    );
  });

  it('keeps the derivation of the numbers in the source', () => {
    // Asserted on RAW: this one is about the reasoning surviving the next edit.
    expect(RAW).toContain('SIDEBAR_DEFAULT_WIDTH');
    expect(RAW).toMatch(/236px/);
  });

  it('is written against the width the app actually ships with', () => {
    // If the default ever moves, the 236px budget above stops describing
    // reality and this file needs re-deriving rather than silently drifting.
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(280);
  });
});

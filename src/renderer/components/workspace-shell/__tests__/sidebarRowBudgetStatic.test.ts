import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';
import { SIDEBAR_DEFAULT_WIDTH } from '../shellLayoutModel';

/**
 * Session rows only render workspace chips; Pi is the sole chat runtime and is
 * no longer repeated as a per-row badge.
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

  it('does not render a runtime agent chip', () => {
    expect(CODE).not.toContain('row.agentChip');
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
    // ~21px of relative age vs 40px of icon buttons (60px on temp rows, which
    // carry a third delete button): without a shared width the swap moves every
    // other item on the row on every hover. Both boxes must widen together, so
    // the width is one conditional expression pinned to appear exactly twice —
    // once on the age span, once on the actions box.
    expect(CODE).toContain(
      "'shrink-0 text-right text-meta text-muted-foreground tabular-nums group-hover:hidden group-focus-within:hidden',"
    );
    expect(CODE).toContain(
      "'hidden shrink-0 items-center justify-end group-hover:flex group-focus-within:flex',"
    );
    const sharedWidthExpr = "onDeleteTemp ? 'w-[60px]' : 'w-10'";
    expect(CODE.split(sharedWidthExpr).length - 1).toBe(2);
  });

  it('keeps the derivation of the numbers in the source', () => {
    // Asserted on RAW: this one is about the reasoning surviving the next edit.
    expect(RAW).toContain('SIDEBAR_DEFAULT_WIDTH');
  });

  it('is written against the width the app actually ships with', () => {
    // If the default ever moves, the 236px budget above stops describing
    // reality and this file needs re-deriving rather than silently drifting.
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(280);
  });
});

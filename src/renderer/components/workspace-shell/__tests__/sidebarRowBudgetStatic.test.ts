import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';
import { DOCK_RAIL_WIDTH, SIDEBAR_DEFAULT_WIDTH } from '../shellLayoutModel';

/**
 * The session row's width budget, as decision 167 (GitHub issue #3) laid it
 * out and the prototype measured it
 * (`docs/plantree/plans/dsh-rebase/evidence/sidebar-hierarchy-2026-10/`).
 *
 * At the 280px default (which includes the panel's 1px right border) a row
 * inside a folder has 280 - 1 - 16 (p-2) - 12 (pl-3) - 16 (px-2) = 235px of
 * content. Minus the 16px status slot, two 6px gaps and the 40px time box the
 * title gets 167px. Pi is the sole chat runtime and is not repeated as a
 * per-row badge; the branch is shown only on a worktree row.
 */

const NAV_FILE = join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const RAW = readFileSync(NAV_FILE, 'utf8');
const CODE = stripComments(RAW, NAV_FILE);
const ROW = CODE.slice(CODE.indexOf('function SessionRow('));

/** The session row's own className, isolated so sibling rows cannot satisfy a scan. */
const SESSION_ROW_CLASS =
  /'group flex h-7 w-full items-center gap-1\.5 overflow-hidden rounded-sm px-2 text-left text-ui'/;

describe('sidebar session row width budget', () => {
  it('keeps the row a single h-7 line with a clipping box', () => {
    // h-7 is the design-system tree-node token; a second line would silently
    // change sidebar density instead of solving the overflow. rounded-sm: the
    // radius clamp rule (h-7 takes rounded-xs / rounded-sm only).
    expect(ROW).toMatch(SESSION_ROW_CLASS);
  });

  it('opens every row with one fixed w-4 status slot, rendered even when empty', () => {
    // The slot is a plain element, not conditional: the spinner, the dots and
    // the selection checkbox all sit inside it, so the title never moves.
    const slotAt = ROW.indexOf('<span className="flex w-4 shrink-0 items-center justify-center">');
    expect(slotAt).toBeGreaterThan(ROW.indexOf('title={tooltip}'));
    expect(slotAt).toBeLessThan(ROW.indexOf('{onToggleSelect && ('));
    expect(slotAt).toBeLessThan(ROW.indexOf('{onToggleSelect ? null : row.busy ? ('));
  });

  it('gives the title a floor so it can never collapse to a bare ellipsis', () => {
    expect(ROW).toContain('<span className="min-w-20 flex-1 truncate">{row.title}</span>');
    // The floor is the invariant. `flex-1 min-w-0` (the pre-fix shape) is the
    // exact thing that let the chips eat the title, so it must not come back.
    expect(ROW).not.toContain('min-w-0 flex-1 truncate">{row.title}');
  });

  it('does not render a runtime agent chip, nor a branch or kind chip per row', () => {
    expect(CODE).not.toContain('row.agentChip');
    // Decision 167 replaced D21-A: no Badge-shaped chip on the row at all.
    expect(ROW).not.toContain('row.chip');
    expect(ROW).not.toContain("variant === 'kind'");
  });

  it('makes the worktree branch text the sole yielder, last segment only', () => {
    const at = ROW.indexOf('{branch && (');
    expect(at).toBeGreaterThan(ROW.indexOf('{row.title}</span>'));
    const text = ROW.slice(at, ROW.indexOf('</span>', at));
    expect(text).toContain(
      'className="min-w-0 max-w-24 shrink truncate text-meta text-muted-foreground"'
    );
    expect(text).toContain('title={branch}');
    expect(text).toContain('{lastBranchSegment(branch)}');
    // shrink-0 on it would send the deficit straight back to the title.
    expect(text).not.toContain('shrink-0');
  });

  it('passes a branch only inside a folder, and only off the main workspace', () => {
    // Exactly one call site hands a branch down — the folder rows — and it
    // asks `chipShownInFolder`; Recent and the temporary-chat section never do.
    expect(CODE.split('branch={').length - 1).toBe(1);
    expect(CODE).toContain('chipShownInFolder(row, primary) ? row.chip?.label : undefined');
  });

  it('sizes the age/actions swap to one fixed box so hovering cannot re-flow the row', () => {
    // ~21px of relative age vs 40px of icon buttons (60px on temp rows, which
    // carry a third delete button): without a shared width the swap moves every
    // other item on the row on every hover. Both boxes must widen together, so
    // the width is one conditional expression pinned to appear exactly twice —
    // once on the age span, once on the actions box.
    expect(ROW).toContain(
      "'shrink-0 text-right text-meta text-muted-foreground tabular-nums group-hover:hidden group-focus-within:hidden',"
    );
    expect(ROW).toContain(
      "'hidden shrink-0 items-center justify-end group-hover:flex group-focus-within:flex',"
    );
    const sharedWidthExpr = "onDeleteTemp ? 'w-[60px]' : 'w-10'";
    expect(ROW.split(sharedWidthExpr).length - 1).toBe(2);
  });

  it('makes the hover buttons fit that box: 20px each, desktop included', () => {
    // `icon-xs` is `size-7 sm:size-6`; a bare `size-5` (or `h-5 w-5`) loses to
    // the variant's `sm:size-6` on desktop, and two 24px buttons are 48px in a
    // 40px box. Every hover button in the row says `sm:size-5` too.
    expect(ROW).not.toContain('className="h-5 w-5');
    const actions = ROW.slice(
      ROW.indexOf("'hidden shrink-0 items-center justify-end"),
      ROW.indexOf('</ContextMenuPrimitive.Trigger>')
    );
    expect(actions.split('className="size-5 sm:size-5"').length - 1).toBe(2);
    expect(CODE).toContain(
      'className="size-5 text-muted-foreground hover:text-destructive sm:size-5"'
    );
  });

  /**
   * dsh-rebase P1-9e: the `1.0.x` mark on a diverged legacy row. It is what
   * tells that row from the migrated chat of the same title, so it never
   * yields; it stays Latin-only — the sentence is its tooltip, translated.
   * Decision 167 moved it to Badge `lg` with the other alert badges.
   */
  it('keeps the 1.0.x mark whole, Latin-only, and explained by a translated tooltip', () => {
    const start = ROW.indexOf('{row.legacyDiverged && (');
    expect(start).toBeGreaterThan(ROW.indexOf('{row.title}</span>'));
    const badge = ROW.slice(start, ROW.indexOf('</Badge>', start));
    expect(badge).toContain('size="lg"');
    expect(badge).toContain('className="shrink-0"');
    expect(badge).toContain('title={t(LEGACY_DIVERGED_HINT)}');
    expect(badge).toContain('1.0.x');
    expect(badge).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('unifies the alert badges at Badge lg (14px)', () => {
    const badges = [...ROW.matchAll(/<Badge[\s\S]*?>/g)].map((match) => match[0]);
    expect(badges).toHaveLength(3);
    for (const badge of badges) expect(badge).toContain('size="lg"');
  });

  it('keeps the derivation of the numbers in the source', () => {
    // Asserted on RAW: this one is about the reasoning surviving the next edit.
    expect(RAW).toContain('SIDEBAR_DEFAULT_WIDTH');
    expect(RAW).toContain('the title gets 167px');
  });

  it('is written against the width the app actually ships with', () => {
    // If the default ever moves, the 235px / 167px budget above stops
    // describing reality and this file needs re-deriving rather than silently
    // drifting.
    //
    // D08: `SIDEBAR_DEFAULT_WIDTH` measures the whole dock now (rail + panel),
    // so the number the rows actually live inside is the panel — the rail is
    // chrome they never see. That is what this asserts.
    expect(SIDEBAR_DEFAULT_WIDTH - DOCK_RAIL_WIDTH).toBe(280);
  });
});

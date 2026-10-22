import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';
import { SIDEBAR_DEFAULT_WIDTH } from '../shellLayoutModel';

/**
 * The session row's width budget. Decision 167 (GitHub issue #3) laid it out;
 * decision 183 (prototype in
 * `docs/plantree/plans/dsh-rebase/evidence/sidebar-claude-style-2026-10/`)
 * widened it: rows are no longer indented under their group (`pl-3` gone) and
 * the trailing time box is gone — the hover actions float over the row's right
 * edge instead of taking width.
 *
 * At the 272px default (design system v2 / layout 5a: the sidebar alone, which
 * includes its 1px right border) a row has 272 - 1 - 16 (the list's px-2) - 16
 * (the row's px-2) = 239px of content. Layout 5b (the desktop screenshot):
 * no leading slot — the state is a 14px TRAILING mark — so minus the mark and
 * one 6px gap the title gets 219px. Pi is the
 * sole chat runtime and is not repeated as a per-row badge; the branch is
 * shown only on a worktree row.
 */

const NAV_FILE = join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const RAW = readFileSync(NAV_FILE, 'utf8');
const CODE = stripComments(RAW, NAV_FILE);
const ROW = CODE.slice(CODE.indexOf('function SessionRow('));

/**
 * The session row's own className, isolated so sibling rows cannot satisfy a
 * scan. 13px (`text-ui`, design system v2) — smaller than the 14px the budget
 * below was measured at, so the budget still holds; `relative` anchors the
 * floating actions.
 */
const SESSION_ROW_CLASS =
  /'group relative flex h-7 w-full items-center gap-1\.5 overflow-hidden rounded-xs px-2 text-left text-ui'/;

describe('sidebar session row width budget', () => {
  it('keeps the row a single h-7 line with a clipping box', () => {
    // Layout 5b: h-7 (28px, the screenshot's density; decision 188 had h-8);
    // a second line would silently change sidebar density instead of
    // solving the overflow. rounded-xs (design system v2 §7.12; the radius clamp rule keeps small
    // controls off rounded-md and up).
    expect(ROW).toMatch(SESSION_ROW_CLASS);
  });

  it('layout 5b: the title leads the row; the one state mark trails it', () => {
    // The old fixed w-4 leading slot is gone (the screenshot's rows are text
    // first). Only the selection checkbox leads, and only while selecting.
    expect(ROW).not.toContain('<span className="flex w-4 shrink-0 items-center justify-center">');
    const checkboxAt = ROW.indexOf('{onToggleSelect && (');
    const titleAt = ROW.indexOf('{titleParts.suffix === null');
    const markAt = ROW.indexOf('(rowWaiting ? (');
    expect(checkboxAt).toBeGreaterThan(ROW.indexOf('title={tooltip}'));
    expect(checkboxAt).toBeLessThan(titleAt);
    expect(titleAt).toBeLessThan(markAt);
    // Every mark is one 14px cell, so a state change never moves the title.
    const mark = ROW.slice(markAt, ROW.indexOf(') : null)}', markAt));
    expect(
      mark.split('className="inline-grid size-3.5 shrink-0 place-items-center"').length - 1
    ).toBe(3);
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
      'className="min-w-0 max-w-24 shrink truncate text-small text-foreground-faint"'
    );
    expect(text).toContain('title={branch}');
    expect(text).toContain('{lastBranchSegment(branch)}');
    // shrink-0 on it would send the deficit straight back to the title.
    expect(text).not.toContain('shrink-0');
  });

  it('passes a branch only inside a repository group, and only off the main workspace', () => {
    // One row renderer hands `branch` down; only the repository groups give it
    // one, by asking `chipShownInFolder`. Temporary chats never do.
    expect(CODE.split('branch={').length - 1).toBe(1);
    expect(CODE).toContain('branch={branch}');
    expect(CODE).toContain('chipShownInFolder(row, primary) ? row.chip?.label : undefined');
    expect(CODE).toContain('{limited.rows.map((row) => renderSessionRow(row))}');
    // Layout 5b: in 「按状态」 / 「按时间」 (like 「按分组」) the context slot names
    // the repository instead, since no repository heading says it.
    expect(CODE).toContain('renderSessionRow(row, repositoryNameForRow(row) ?? undefined)');
  });

  it('has no time box any more: the actions float over the row and take no width', () => {
    // Decision 183 §1.4. The old age / actions swap needed a shared w-10 box
    // (w-[60px] on temp rows) so hovering could not re-flow the row; an
    // absolutely positioned overlay cannot re-flow anything.
    expect(CODE).not.toContain('formatRelativeAge');
    expect(ROW).not.toContain("'w-[60px]'");
    expect(ROW).not.toContain("'w-10'");
    expect(ROW).toContain(
      "'absolute inset-y-1 right-1.5 hidden items-center group-hover:flex group-focus-visible:flex group-has-focus-visible:flex',"
    );
    // Painted in the row's own fill, fading to the left over the title.
    expect(ROW).toContain(
      "? 'bg-fill-ghost-selected shadow-[-10px_0_8px_var(--fill-ghost-selected)]'"
    );
    expect(ROW).toContain(": 'bg-fill-ghost-hover shadow-[-10px_0_8px_var(--fill-ghost-hover)]'");
    // Not in selection mode: there a click picks the row.
    const actionsAt = ROW.indexOf('data-slot="sidebar-row-actions"');
    expect(ROW.lastIndexOf('{!onToggleSelect && (', actionsAt)).toBeGreaterThan(-1);
  });

  it('makes the hover buttons 20px, desktop included', () => {
    // `icon-xs` is `size-7 sm:size-6`; a bare `size-5` (or `h-5 w-5`) loses to
    // the variant's `sm:size-6` on desktop. Every hover button in the row says
    // `sm:size-5` too.
    expect(ROW).not.toContain('className="h-5 w-5');
    const actions = ROW.slice(
      ROW.indexOf('data-slot="sidebar-row-actions"'),
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

  it('keeps one alert badge, at Badge lg (14px); the others became trailing marks (layout 5b)', () => {
    // The pending-approval count is the waiting mark's words, a failure the
    // warning mark: badges are what the screenshot's quiet rows do not have.
    const badges = [...ROW.matchAll(/<Badge[\s\S]*?>/g)].map((match) => match[0]);
    expect(badges).toHaveLength(1);
    for (const badge of badges) expect(badge).toContain('size="lg"');
    expect(ROW).not.toContain('ShieldQuestion');
  });

  it('rows are not indented under their group header', () => {
    expect(CODE).not.toContain('pl-3');
  });

  it('keeps the derivation of the numbers in the source', () => {
    // Asserted on RAW: this one is about the reasoning surviving the next edit.
    expect(RAW).toContain('SIDEBAR_DEFAULT_WIDTH');
    expect(RAW).toContain('gets 219px');
  });

  it('is written against the width the app actually ships with', () => {
    // If the default ever moves, the 239px / 219px budget above stops
    // describing reality and this file needs re-deriving rather than silently
    // drifting. Layout 5a: no rail any more, so the default IS what the rows
    // live inside.
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(272);
  });
});

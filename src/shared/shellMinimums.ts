/**
 * U25 — the narrowest window the shell can be laid out in without spilling.
 *
 * `resolveShellAllocation` gives chat and the editor a width FLOOR each and, when
 * the row cannot satisfy both, deliberately overflows rather than compressing
 * (`overflowWidth` records how much). That is the right call for content — a
 * panel squeezed to a sliver reads as broken — but it means the rightmost chrome
 * in the editor's toolbar (expand, close) can end up outside the viewport, which
 * is what the user hit: buttons that could be neither seen nor clicked.
 *
 * The user's ruling (2026-09-06) was to stop the window before that point rather
 * than teach every toolbar to compress: 「不要在窗口太小的时候出现图标挤兑异常的
 * 现象就行（限制最小画幅）」.
 *
 * ## Why the sidebar's EXPANDED minimum is in the sum
 *
 * The dock can collapse to its 44px rail, and at that width the shell fits in
 * 964px. Sizing the window to that would leave the overflow reachable again the
 * moment the user opens a panel — which they cannot be expected to predict. The
 * floor is therefore the narrowest window in which EVERY legal layout state
 * fits, not the narrowest one some state fits in.
 *
 * ## Kept in `shared/` on purpose
 *
 * The numbers it is derived from live in the renderer's layout models, and the
 * window that has to honour it is created in Main. A copy on either side would
 * be a second source of truth for the same measurement, and the two would drift
 * silently — the failure would look like "buttons off-screen again" months
 * later. `shellMinimums.test.ts` asserts this value against the renderer
 * constants it claims to be derived from, so a change to any of them fails
 * there rather than in a screenshot.
 */

/** `SIDEBAR_MIN_WIDTH` — 280px panel + the 44px rail (`shellLayoutModel.ts`). */
const SIDEBAR_MIN_WIDTH = 324;
/** `CHAT_MIN_WIDTH` + `EDITOR_MIN_WIDTH` (`centerLayoutModel.ts`'s `contentFloor`). */
const CENTER_ROW_FLOOR = 400 + 520;

export const SHELL_MIN_WIDTH = SIDEBAR_MIN_WIDTH + CENTER_ROW_FLOOR;

/**
 * Unchanged by U25 and not derived from anything: no vertical overflow was
 * reported, and the shell's rows (title bars, composer) already scroll or
 * truncate rather than spill. Exported alongside the width so the window's two
 * minimums are read from one place.
 */
export const SHELL_MIN_HEIGHT = 600;

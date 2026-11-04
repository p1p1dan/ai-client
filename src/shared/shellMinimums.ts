/**
 * U25 → decision 209 — the narrowest window the shell can be laid out in
 * without spilling.
 *
 * U25 (user ruling 2026-09-06): 「不要在窗口太小的时候出现图标挤兑异常的现象就行
 * （限制最小画幅）」. Back then the allocator let the panes run off the right
 * edge when chat and the panes could not both hold their floors, so the window
 * was stopped at sidebar + chat + one pane (960).
 *
 * Decision 209 §5 (user, 2026-11-04: 「当前会话窗口的尺寸限制的太死了，有时我想把窗口
 * 缩小一点都没办法」) keeps the requirement — nothing spills, no button ends up
 * out of reach — and meets it in the layout instead of the window:
 *  - a sidebar wider than its floor gives way first (`resolveSidebarWidth`);
 *  - panes that do not fit beside the chat stack into one column, then lie
 *    over the chat as a drawer (`fitShell`, the allocator's `editorOverlay`);
 *  - title-bar buttons that do not fit move into its ⋮ menu.
 * So the floor is the sidebar's minimum plus the chat's: the narrowest window
 * in which EVERY legal layout state still fits (the expanded sidebar beside the
 * chat), which was U25's rule for choosing the number and still is.
 *
 * ## Kept in `shared/` on purpose
 *
 * The numbers it is derived from live in the renderer's layout models, and the
 * window that has to honour it is created in Main. A copy on either side would
 * be a second source of truth for the same measurement, and the two would drift
 * silently. `shellMinimums.test.ts` asserts this value against the renderer
 * constants it claims to be derived from, so a change to any of them fails
 * there rather than in a screenshot.
 */

/** `SIDEBAR_MIN_WIDTH` (`shellLayoutModel.ts`). */
const SIDEBAR_MIN_WIDTH = 240;
/** `CHAT_MIN_WIDTH` (`centerLayoutModel.ts`): panes cover the chat rather than sit beside it. */
const CENTER_ROW_FLOOR = 400;

export const SHELL_MIN_WIDTH = SIDEBAR_MIN_WIDTH + CENTER_ROW_FLOOR;

/**
 * Decision 209 §5: 600 → 480. Not derived from anything: the shell's rows
 * (title bar, composer) hold their height, and everything between them — the
 * conversation, the sidebar list, the rail, the pane cards — scrolls.
 */
export const SHELL_MIN_HEIGHT = 480;

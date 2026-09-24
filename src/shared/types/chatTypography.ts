/**
 * T104: the chat area's configurable typeface and its two size tiers.
 *
 * This is the single place the numbers and the clamp rules live, because four
 * consumers need to agree on them and none of them can see the others:
 *
 *  - `globals.css`'s `@theme` declares the two sizes as `--text-chat-body` /
 *    `--text-chat-process` (a stylesheet, so it spells the px values directly);
 *  - `stores/settings` holds them as user settings and clamps every write;
 *  - `ChatWorkspace` writes them onto the chat column's root node as inline
 *    custom properties;
 *  - `middleColumnLayout`'s composer height arithmetic is derived from the
 *    body default (`DEFAULT_CHAT_BODY_FONT_SIZE * COMPOSER_TEXTAREA_LINE_SCALE`).
 *
 * The ranges are deliberately asymmetric. The floor of BOTH is 12px rather than
 * a lower number because of the CJK rule in design-system.md: 10px may not
 * carry Chinese at all, and any position that can contain Chinese bottoms out
 * at the meta tier (13px). The process tier is the one that carries Chinese
 * verbs ("读取", "编辑"), so 12 is already a deliberate stretch below that
 * 13px guidance and must not be lowered further.
 *
 * The two are also clamped AGAINST EACH OTHER — process may never exceed body.
 * A reader can reasonably want a bigger body, and can reasonably want a smaller
 * process tier, but "the process information is larger than the answer" is not
 * a preference, it is a broken screen, so no setting path may produce it.
 */

/** Upper bound of the body tier (px). Above this a 45rem reading column is a few words wide. */
export const CHAT_BODY_FONT_SIZE_MAX = 24;

/** Lower bound of the body tier (px) — see the module note on the 12px floor. */
export const CHAT_BODY_FONT_SIZE_MIN = 12;

/** D1: the out-of-the-box body tier. Mirrors `--text-chat-body` in `globals.css`. */
export const DEFAULT_CHAT_BODY_FONT_SIZE = 17;

/** Upper bound of the process tier (px). Lower than the body's: it is the subordinate tier. */
export const CHAT_PROCESS_FONT_SIZE_MAX = 20;

/** Lower bound of the process tier (px) — the CJK floor, see the module note. */
export const CHAT_PROCESS_FONT_SIZE_MIN = 12;

/** D1: the out-of-the-box process tier. Mirrors `--text-chat-process` in `globals.css`. */
export const DEFAULT_CHAT_PROCESS_FONT_SIZE = 14;

/** Empty string means "follow the app's `--font-sans`" — a real value, not a missing one. */
export const DEFAULT_CHAT_FONT_FAMILY = '';

/** An integer inside `[min, max]`; `fallback` when the input cannot be one. */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The pair a write to the BODY tier must land on.
 *
 * Raising the body is always allowed on its own terms; LOWERING it below the
 * current process tier pulls the process tier down with it rather than refusing
 * the write — the reader asked for a smaller body, and a control that silently
 * does nothing is worse than one that moves its neighbour.
 *
 * A non-finite input is not a value the caller can mean, so it falls back to
 * the default rather than to the floor: `Number('')` is `NaN`, and a cleared
 * number input should restore the shipped size, not slam the tier to 12px.
 */
export function resolveChatBodyWrite(
  size: number,
  processSize: number
): { body: number; process: number } {
  const currentProcess = clampInt(
    processSize,
    CHAT_PROCESS_FONT_SIZE_MIN,
    CHAT_PROCESS_FONT_SIZE_MAX,
    DEFAULT_CHAT_PROCESS_FONT_SIZE
  );
  const body = clampInt(
    size,
    CHAT_BODY_FONT_SIZE_MIN,
    CHAT_BODY_FONT_SIZE_MAX,
    DEFAULT_CHAT_BODY_FONT_SIZE
  );
  return { body, process: Math.min(currentProcess, body) };
}

/**
 * The pair a write to the PROCESS tier must land on.
 *
 * Exceeding the body is clamped down to it rather than refused: the control
 * offers the body size as its own `max`, and this is the store-side guarantee
 * that survives a caller which ignores the control.
 */
export function resolveChatProcessWrite(
  size: number,
  bodySize: number
): { body: number; process: number } {
  const body = clampInt(
    bodySize,
    CHAT_BODY_FONT_SIZE_MIN,
    CHAT_BODY_FONT_SIZE_MAX,
    DEFAULT_CHAT_BODY_FONT_SIZE
  );
  const process = clampInt(
    size,
    CHAT_PROCESS_FONT_SIZE_MIN,
    CHAT_PROCESS_FONT_SIZE_MAX,
    DEFAULT_CHAT_PROCESS_FONT_SIZE
  );
  return { body, process: Math.min(process, body) };
}

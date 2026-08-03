import { flattenTurnItems, type Turn, type TurnItem } from './chatTurn';

/**
 * T-31 turn copy payload (reply-anatomy spec §4.6 / polish-audit P-34).
 *
 * Deliberately narrow: only the turn's prose blocks, in block order, joined by
 * a blank line. Tool `toolInput` / `toolOutput` and thinking bodies are
 * excluded — a raw tool output can carry absolute paths, environment values or
 * secret fragments, and "copy this reply" must not become an exfiltration path
 * (F-B7 asserts the exclusion; the spec's risk table names it).
 *
 * Scope follows `flattenTurnItems`: `text` items only, which by construction
 * come from assistant messages. `system` / `error` notices flatten to `notice`
 * items and are therefore excluded too — copying a reply should not pick up the
 * client's own error banners. The user's own prompt is not included either
 * (§4.6 defines the payload as the turn's answer + process prose).
 */
export function buildTurnCopyText(turn: Turn): string {
  return buildTurnCopyTextFromItems(flattenTurnItems(turn));
}

/**
 * The same payload, built from an already-flattened item list (review batch
 * F7).
 *
 * `MessageTimeline` flattens the turn once for rendering anyway, and calling
 * `buildTurnCopyText(turn)` beside it ran `flattenTurnItems` — and through it
 * `groupTimeline` / `pairToolBlocks` over every block in the turn — a second
 * time on every render, including every one-second clock tick. This overload is
 * the one the renderer uses; the `Turn` form above stays as the module's public
 * shape (and is what `turnCopy.test.ts` pins), delegating so the two can never
 * produce different text.
 */
export function buildTurnCopyTextFromItems(items: readonly TurnItem[]): string {
  return items
    .map((item) => (item.kind === 'text' ? (item.block.text ?? '') : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

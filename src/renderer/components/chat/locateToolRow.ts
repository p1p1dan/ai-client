/**
 * dsh-rebase P1-7b (prototype scene D, 「定位」): bring a delegation row into
 * view — the subagents window's way back to where a child was started.
 *
 * The row may sit in a turn's folded work group (a native `<details>` whose
 * summary click is the group's one open control, `MessageTimeline`'s
 * `TurnProgressHead`): the summary is clicked so the group opens through its
 * own handler, then the row is scrolled to the middle and marked for a moment
 * (`data-located`, which the row's class shows as the selection colour).
 */

/** How long the row stays marked. */
export const LOCATE_MARK_MS = 1_400;

export function locateToolRow(toolCallId: string, root: ParentNode = document): boolean {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(toolCallId)
      : toolCallId.replace(/["\\]/g, '\\$&');
  const target = root.querySelector<HTMLElement>(`[data-tool-call-id="${escaped}"]`);
  if (!target) return false;
  const group = target.closest('details');
  if (group && !group.open) group.querySelector<HTMLElement>(':scope > summary')?.click();
  const reveal = () => {
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    target.setAttribute('data-located', '');
    setTimeout(() => target.removeAttribute('data-located'), LOCATE_MARK_MS);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  else reveal();
  return true;
}

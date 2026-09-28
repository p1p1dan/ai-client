/**
 * `aiclient:permission` — the posture a session's gate is on, told to the
 * model (dsh-rebase P1-6b; design shard 03 §8).
 *
 * 1.0.x put the same two sentences in two system-prompt slots
 * (`promptText.ts`: `mode`, `permission-gear`). Under DSH they are dynamic
 * runtime context instead (`systemPrompt.context`), beside DSH's own
 * `sandbox:policy` and `approval:policy`: DSH re-renders the context for
 * every step and appends a new snapshot only when the text changed, so a
 * posture change reaches the model from its next step, and an unchanged one
 * costs nothing.
 */

import { modeSegment, permissionGearSegment } from '../../shared/permissions/promptText.ts';
import type { PermissionGear, RuntimeMode } from '../../shared/types/runtimePermission.ts';

/** The context's name in DSH's prompt registry. */
export const PERMISSION_PROMPT_CONTEXT = 'aiclient:permission';

/**
 * Where it sits among DSH's runtime contexts: right after `approval:policy`
 * (which says approvals may ask), which it narrows down.
 */
export const PERMISSION_PROMPT_CONTEXT_AFTER = 'APPROVAL_POLICY';

/** The mode's sentence, then the gear's: 1.0.x's two slots, in 1.0.x's words. */
export function permissionPromptText(mode: RuntimeMode, gear: PermissionGear): string {
  return `${modeSegment(mode).text}\n${permissionGearSegment(gear).text}`;
}

// Moved from src/runtime/plugins/permissions/prompt.ts (dsh-rebase P1-6a)

import type { PermissionGear, RuntimeMode } from '../types/runtimePermission.ts';

/** One system-prompt slot; the same shape as the runtime's `PromptSegment`. */
export interface PermissionPromptSegment {
  slot: string;
  text: string;
}

const GEAR_TEXT: Record<PermissionGear, string> = {
  ask: 'Permission gear: ask. Writes, edits and shell calls require approval. Wait for the tool result.',
  'accept-edits':
    'Permission gear: accept-edits. Workspace writes, edits and bash calls are allowed without ordinary approval. External paths and external directories still require approval.',
  auto: 'Permission gear: auto. Available tools may execute without ordinary approval. Dangerous commands (any delete, force pushes, hard resets and the like) and anything that names a path outside the workspace still ask every time. Explicit deny rules and the tool whitelist remain enforced.',
  bypass:
    'Permission gear: bypass. The user has turned off approval prompts entirely: available tools execute without approval, including shell commands whose operands cannot be resolved statically. Explicit deny rules and the tool whitelist remain enforced, and a denied call is still denied.',
};
/** Decision 192: `auto` when a review model checks what would otherwise ask. */
const AUTO_REVIEWED_TEXT =
  'Permission gear: auto. Available tools may execute without ordinary approval. Calls that would otherwise ask (dangerous commands such as deletes, force pushes and hard resets, anything that names a path outside the workspace, and program tools) are checked by an automatic safety review first; a call it does not allow fails with the reason, and must not be retried in another form. Explicit deny rules and the tool whitelist remain enforced.';

export function permissionGearSegment(
  gear: PermissionGear,
  options: { autoReview?: boolean } = {}
): PermissionPromptSegment {
  const text = gear === 'auto' && options.autoReview ? AUTO_REVIEWED_TEXT : GEAR_TEXT[gear];
  return {
    slot: 'permission-gear',
    text: `${text} Never bypass a denied tool or path by switching tools.`,
  };
}
export function modeSegment(mode: RuntimeMode): PermissionPromptSegment {
  return {
    slot: 'mode',
    text:
      mode === 'plan'
        ? 'Mode: plan. Inspect and produce an implementation plan for user approval. Write, Edit and write-capable plugins are unavailable. Bash is for inspection only; do not use it to modify files or execute the plan.'
        : 'Mode: agent. Execute the approved work with the available tools, under the selected permission gear.',
  };
}

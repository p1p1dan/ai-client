import type { PermissionGear, RuntimeMode } from '../../../shared/types/runtimePermission.ts';
import type { PromptSegment } from '../prompt/segments.ts';

const GEAR_TEXT: Record<PermissionGear, string> = {
  ask: 'Permission gear: ask. Writes, edits and shell calls require approval. Wait for the tool result.',
  'accept-edits':
    'Permission gear: accept-edits. Workspace writes, edits and bash calls are allowed without ordinary approval. External paths and external directories still require approval.',
  auto: 'Permission gear: auto. Available tools may execute without ordinary approval. Explicit deny rules and the tool whitelist remain enforced.',
};
export function permissionGearSegment(gear: PermissionGear): PromptSegment {
  return {
    slot: 'permission-gear',
    text: `${GEAR_TEXT[gear]} Never bypass a denied tool or path by switching tools.`,
  };
}
export function modeSegment(mode: RuntimeMode): PromptSegment {
  return {
    slot: 'mode',
    text:
      mode === 'plan'
        ? 'Mode: plan. Inspect and produce an implementation plan for user approval. Write, Edit and write-capable plugins are unavailable. Bash is for inspection only; do not use it to modify files or execute the plan.'
        : 'Mode: agent. Execute the approved work with the available tools, under the selected permission gear.',
  };
}

/**
 * dsh-rebase decision 169: a plan review's approval moves the chat's posture
 * from inside the worker — plan mode to execute mode, full auto or bypass —
 * without the composer asking. Main forwards that change only for an answer
 * it forwarded itself (`session.permissions`, cause `plan-approved`), and
 * restates its own posture to a window that reopens the chat with an older
 * one (cause `sync`).
 *
 * Either way the chat's stored posture becomes that one and the chip reads it
 * again (`notePostureSynced`, the revision the P1-9e migration added); an
 * approval also says so in a toast, with why its goal was not set when it
 * was not. Installed once per window (`App`), so a change for a chat that is
 * not on screen is stored too.
 */

import type { ChatEngine } from '@shared/claudeSdkEngine';
import type { Translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import {
  isRuntimePermissionSettings,
  permissionPresetLabelsFor,
  presetOf,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';
import { permissionModeRefusalReasonText } from '@/components/chat/permissionModeRefusal';
import { subscribeRuntimeEvent } from './runtimeEventBus';

export interface PlanApprovalPostureEffects {
  t: Translate;
  writeSessionPermissions(sessionId: string, settings: RuntimePermissionSettings): void;
  notePostureSynced(sessionId: string): void;
  toast(toast: { type: 'info' | 'warning'; title: string; description?: string }): void;
  /** Route B, S-2: the engine the chat reported; its posture is named in that engine's words. */
  engineOf?(sessionId: string): ChatEngine | undefined;
}

/** Fold one runtime event; anything but `session.permissions` is ignored. */
export function applyPlanApprovalPosture(
  event: RuntimeEvent,
  effects: PlanApprovalPostureEffects
): void {
  if (event.type !== 'session.permissions' || !event.sessionId) return;
  const { permissions, cause, goal } = event.payload ?? {};
  if (!isRuntimePermissionSettings(permissions)) return;
  effects.writeSessionPermissions(event.sessionId, permissions);
  effects.notePostureSynced(event.sessionId);
  const labels = permissionPresetLabelsFor(effects.engineOf?.(event.sessionId));
  const preset = effects.t(labels[presetOf(permissions)]);
  // Route B, S-2 (A-6): the SDK engine changed its own mode (plan mode entered or
  // left); said once. A mode it refused (A-7) is a warning, with why.
  if (cause === 'engine') {
    const refused = event.payload?.refusedReason;
    effects.toast({
      type: refused ? 'warning' : 'info',
      title: effects.t('Mode is now {{preset}}', { preset }),
      ...(refused ? { description: effects.t(permissionModeRefusalReasonText(refused)) } : {}),
    });
    return;
  }
  if (cause !== 'plan-approved') return;
  effects.toast({
    type: goal?.set === false ? 'warning' : 'info',
    title: effects.t('Plan approved: switched to {{preset}}', { preset }),
    ...(goal?.set === false
      ? { description: effects.t('Goal not set: {{reason}}', { reason: goal.reason }) }
      : {}),
  });
}

/**
 * Subscribe for the life of the window. `effects` is read at each event, so
 * the translator follows the language setting.
 */
export function startPlanApprovalPostureWatch(
  effects: () => PlanApprovalPostureEffects
): () => void {
  return subscribeRuntimeEvent((event) => applyPlanApprovalPosture(event, effects()));
}

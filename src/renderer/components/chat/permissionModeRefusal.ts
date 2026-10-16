/**
 * Route B, S-2 (plan topic s2-permission-modes.md A-5): the Claude Agent SDK
 * engine refused a permission mode. The worker reports
 * `WORKER_PERMISSION_MODE_REFUSED: <reason>`, which reaches the renderer inside
 * Electron's invoke error text; the chip says why in PiLab's words instead of
 * showing that text.
 */

import {
  PERMISSION_MODE_REFUSED,
  type PermissionModeRefusalReason,
  permissionModeRefusalReason,
} from '@shared/claudeSdkEngine';

const PATTERN = new RegExp(`(?:^|[^A-Za-z0-9_])${PERMISSION_MODE_REFUSED}: ([a-z_]+)`);

/** Dictionary keys, by reason. */
const REFUSAL_TEXT: Record<PermissionModeRefusalReason, string> = {
  auto_mode_model: 'This model cannot run in Auto mode.',
  auto_mode_settings: 'Auto mode is turned off by settings.',
  auto_mode_circuit_breaker: 'Auto mode is not available right now.',
  auto_mode_unavailable: 'Auto mode is not available right now.',
  auto_mode_fast_mode: 'Auto mode is not available while fast mode is on.',
  bypass_disabled: 'Bypass permissions is turned off by settings.',
  bypass_restricted: 'Bypass permissions is turned off by settings.',
  bypass_not_launched: 'This chat cannot switch to Bypass permissions. Start a new chat for it.',
  invalid_mode: 'The engine refused this mode.',
  timeout: 'The engine did not answer in time. Try again.',
  other: 'The engine refused this mode.',
};

/** The dictionary key that says why, or null when the error is not a refusal. */
export function permissionModeRefusalText(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = PATTERN.exec(message);
  return match ? permissionModeRefusalReasonText(match[1] as string) : null;
}

/** The dictionary key for a refusal reason as the engine reports it (`refusedReason`). */
export function permissionModeRefusalReasonText(reason: string): string {
  return REFUSAL_TEXT[permissionModeRefusalReason(reason)];
}

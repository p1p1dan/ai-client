import type { RuntimeEventDraft } from '../../../shared/types/runtimeEvents.ts';
import type { PermissionActivityRecord, PermissionDecisionSource } from './index.ts';

/**
 * P4-5 — the gate's own record, as the timeline row the renderer already draws.
 *
 * ## Why this projection exists
 *
 * The approval modal answers one question and then disappears. Two things it
 * cannot say afterwards: what was decided, and what was decided WITHOUT asking.
 * Every `policy` allow resolves with no dialog at all, so this row is the only
 * evidence anywhere that the call was gated rather than simply unchecked — and
 * "the permission system is silently not running" looks exactly the same as
 * "nothing needed approval". The legacy backend has had this since T08-b, by
 * observing `@gotgenes/pi-permission-system`'s broadcasts; the self-owned gate
 * has to supply it itself or the native backend loses the audit trail.
 *
 * ## Why `resolution` speaks the plugin's vocabulary
 *
 * `permissionActivityRow.ts` decides how loudly to draw the row from a small
 * allow-list of resolutions the USER produced (`user_approved` and friends), so
 * that an automatic allow is not drawn like a decision somebody made. Our own
 * source names are mapped onto that vocabulary rather than passed through: an
 * unrecognised value falls on the quiet side, which would render every
 * user-approved write as though a rule had allowed it.
 */
const RESOLUTION: Record<PermissionDecisionSource, string> = {
  policy: 'policy_allow',
  'session-grant': 'session_grant',
  'allow-once': 'user_approved',
  'allow-session': 'user_approved',
  'policy-deny': 'policy_deny',
  'user-denied': 'user_denied',
  cancelled: 'cancelled',
  error: 'gate_error',
};

export function permissionActivityEvent(
  sessionId: string,
  record: PermissionActivityRecord
): RuntimeEventDraft {
  const { request } = record;
  // The tool call IS the correlation id here. The renderer keeps one block per
  // `requestId` and merges the phases into it, and our gate runs once per call,
  // so the prompt and the decision have to agree on this or the transcript
  // grows two rows for one question.
  const detail = request.command ?? request.path;
  return {
    type: 'permission.activity',
    sessionId,
    payload: {
      phase: record.phase,
      requestId: request.toolCallId,
      surface: request.tool,
      ...(detail ? { value: detail } : {}),
      ...(record.phase === 'decision'
        ? { result: record.decision, resolution: RESOLUTION[record.source] }
        : {}),
    },
  };
}

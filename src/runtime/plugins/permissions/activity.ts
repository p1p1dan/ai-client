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
 *
 * The same rule covers the row's `value`: the renderer documents it as the
 * thing that was EVALUATED, so it gets `policyValue` wherever a tool's policy
 * vocabulary differs from its path (chat-tool-06).
 */
const RESOLUTION: Record<PermissionDecisionSource, string> = {
  policy: 'policy_allow',
  'session-grant': 'session_grant',
  'allow-once': 'user_approved',
  'allow-session': 'user_approved',
  'policy-deny': 'policy_deny',
  'user-denied': 'user_denied',
  // Not in `USER_RESOLUTIONS`, and that is the point: a countdown running out
  // is not a decision anybody made, so the row must not be drawn as one.
  'timed-out': 'timed_out',
  cancelled: 'cancelled',
  error: 'gate_error',
};

export function permissionActivityEvent(
  sessionId: string,
  record: PermissionActivityRecord
): RuntimeEventDraft {
  const { request } = record;
  // chat-tool-06 — what the gate actually MATCHED, which is not always the path
  // it was handed. An MCP call carries `path: cwd` as a placeholder and matches
  // on `policyValue` (`server:tool`); a skill's path is the file on disk while
  // its policy value is the skill name. Printing the path for those two read as
  // though a whole directory had been approved.
  const detail = request.policyValue ?? request.command ?? request.path;
  // Who the gate was raised for. Attribution only: a delegate's call resolves
  // under the same session-scoped grants as anyone else's (decision 003), so
  // these two fields change what the row SAYS and never what it allows.
  const delegation = request.delegation;
  return {
    type: 'permission.activity',
    sessionId,
    payload: {
      phase: record.phase,
      // The tool call IS the correlation id here. The renderer keeps one block
      // per `requestId` and merges the phases into it, and our gate runs once
      // per call, so the prompt and the decision have to agree on this or the
      // transcript grows two rows for one question.
      requestId: request.toolCallId,
      surface: request.tool,
      ...(detail ? { value: detail } : {}),
      ...(delegation
        ? { delegationId: delegation.delegationId, agentName: delegation.agentName }
        : {}),
      ...(record.phase === 'decision'
        ? { result: record.decision, resolution: RESOLUTION[record.source] }
        : {}),
    },
  };
}

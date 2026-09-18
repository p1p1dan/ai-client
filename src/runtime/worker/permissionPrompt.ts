/**
 * The native backend's permission gate, asked as a structured event.
 *
 * The renderer has carried a permission card, a pending-permission queue and a
 * `permission_request` block since long before this file — what it never had
 * was a producer. Both backends asked through `ui.select`, so a gate arrived as
 * a blob of title text plus a list of option strings, and the card could only
 * print them: the tool name, the matched rule and a serialized argument object,
 * stacked full width. That is the card the 2026-09-10 screenshots showed.
 *
 * So the question travels as `permission.requested` and the answer comes back
 * as one `worker.permission.respond` call, keyed by the same `permissionId` the
 * block and the queue already use. What the card renders is then a decision
 * about content — "run this command", "write this into that file" — rather than
 * about the permission engine's own vocabulary.
 */

import type {
  PermissionDecisionId,
  PermissionRequestAction,
  PermissionRequestKind,
  RuntimeEventDraft,
} from '../../shared/types/runtimeEvents.ts';
import {
  PERMISSION_TIMEOUT_MS,
  PERMISSION_TIMEOUT_REASON,
  type PermissionConfig,
  type ToolPermissionRequest,
} from '../plugins/permissions/index.ts';

/** The three answers this runtime can act on; `cancel` is not modelled. */
const OFFERED: PermissionDecisionId[] = ['allow', 'allow_session', 'deny'];

export interface PermissionPromptOptions {
  sessionId: string;
  cwd: string;
  emit: (event: RuntimeEventDraft) => void;
  /**
   * The deadline the card counts down to, which must be the one the engine
   * actually enforces — a card promising 120s while the gate aborted at 30s
   * would be worse than no clock at all. Defaults to the engine's own default,
   * which is what a worker that configures no override gets.
   */
  timeoutMs?: number;
}

export interface PermissionPrompt {
  approve: NonNullable<PermissionConfig['approve']>;
  /** `false` when nothing was waiting on that id — see the RPC result's doc. */
  respond: (input: { permissionId: string; decision: PermissionDecisionId }) => boolean;
  /**
   * Settle everything still parked, e.g. on dispose. Answers are denials.
   *
   * "Parked" means ASKED: the gate serializes approvals, so requests queued
   * behind the card on screen have never called `approve` and are invisible
   * here. Draining therefore answers the card and lets the next one up — it is
   * not a way to cancel a whole burst. Both callers abort alongside it, which
   * is what actually clears the queue.
   */
  drain: (reason: 'session_closed' | 'aborted') => void;
}

function kindOf(tool: string): PermissionRequestKind {
  if (tool === 'bash') return 'exec';
  if (tool === 'write' || tool === 'edit') return 'file_change';
  return 'tool';
}

/**
 * What the tool is about to do, in the terms of the decision — as an ID.
 *
 * T023: these four were finished Chinese sentences until 2026-09-15, emitted
 * from a worker that has no idea what language the window is in. Language is a
 * user setting (Settings · General), so every English install read its
 * permission cards in Chinese and the guard that would have caught it
 * (`noHardcodedChinese.test.ts`) did not scan this directory. The wording now
 * lives in the renderer and the Chinese in `zhTranslations`.
 *
 * `undefined` for anything else: an invented sentence for an unknown tool
 * would be worse than the tool's own name, which the card already shows.
 */
function actionOf(tool: string): PermissionRequestAction | undefined {
  switch (tool) {
    case 'bash':
      return 'run_command';
    case 'write':
      return 'write_file';
    case 'edit':
      return 'edit_file';
    case 'read':
      return 'read_file';
    default:
      return undefined;
  }
}

/**
 * The card body, from what the permission engine already knows.
 *
 * `write` reports `add` rather than `update` only when the tool said so; the
 * gate runs before the write, so guessing from the filesystem here would race
 * the very operation being approved.
 */
function detailOf(request: ToolPermissionRequest, cwd: string) {
  if (request.tool === 'bash') {
    return {
      kind: 'exec' as const,
      ...(request.command ? { command: request.command } : {}),
      cwd,
    };
  }
  if (request.tool === 'write' || request.tool === 'edit') {
    return {
      kind: 'file_change' as const,
      changes: [
        {
          path: request.path,
          change: request.tool === 'write' ? ('add' as const) : ('update' as const),
        },
      ],
    };
  }
  return undefined;
}

export function createPermissionPrompt(options: PermissionPromptOptions): PermissionPrompt {
  const pending = new Map<
    string,
    (
      decision: PermissionDecisionId,
      autoReason?: 'session_closed' | 'aborted' | 'timed_out'
    ) => void
  >();

  const resolved = (
    permissionId: string,
    allow: boolean,
    decision: PermissionDecisionId,
    autoReason?: 'session_closed' | 'aborted' | 'timed_out'
  ) => {
    options.emit({
      type: 'permission.resolved',
      sessionId: options.sessionId,
      payload: {
        permissionId,
        allow,
        decision,
        ...(autoReason ? { autoReason } : {}),
      },
    });
  };

  return {
    approve: (request, signal, queue) =>
      new Promise((resolve) => {
        // The tool call id is the permission id, which is what the timeline
        // already assumes (`chatSessions.ts` calls it out): one gate per call.
        const permissionId = request.toolCallId;
        const detail = detailOf(request, options.cwd);
        const action = actionOf(request.tool);
        options.emit({
          type: 'permission.requested',
          sessionId: options.sessionId,
          payload: {
            permissionId,
            toolName: request.tool,
            // T023: an id, not a sentence. `description` stays reserved for
            // prose an agent wrote, which is content and must not be
            // translated — see the field's doc on `PermissionRequestedEvent`.
            ...(action ? { action } : {}),
            // What the tool is about to do, for the card to show verbatim.
            // Kept separate from `detail` because `PermissionFileChange` models
            // a diff, and a pre-write gate has no before-image to diff against.
            input: {
              ...(request.path ? { path: request.path } : {}),
              ...(request.command ? { command: request.command } : {}),
              ...(request.preview
                ? { content: request.preview.text, contentLabel: request.preview.label }
                : {}),
              workspace: options.cwd,
            },
            kind: kindOf(request.tool),
            // P5-2-6. Which delegate is asking. The renderer joins on `agentId`
            // to put "from subagent" on the card and "Awaiting permission" on
            // the delegation's own panel; without it a delegate's gate looked
            // like the main agent's, which is the exact confusion T-34 was
            // built to end. Absent on the parent's own calls, and that absence
            // is the signal, not a missing field.
            ...(request.delegation
              ? {
                  agentId: request.delegation.delegationId,
                  agentName: request.delegation.agentName,
                }
              : {}),
            decisions: OFFERED,
            timeoutMs: options.timeoutMs ?? PERMISSION_TIMEOUT_MS,
            // Where this card sits in the gate's line, forwarded verbatim. The
            // engine owns the queue and is the only thing that can count it:
            // the renderer cannot, because serialization means its own pending
            // list holds exactly one entry while a card is up. Absent when the
            // approver was called without a slot, which is every caller that
            // drives `approve` directly.
            ...(queue ? { queuePosition: queue.position, queueDepth: queue.depth } : {}),
            ...(detail ? { detail } : {}),
          },
        });

        let settled = false;
        const settle = (
          decision: PermissionDecisionId,
          autoReason?: 'session_closed' | 'aborted' | 'timed_out'
        ) => {
          if (settled) return;
          settled = true;
          pending.delete(permissionId);
          signal.removeEventListener('abort', onAbort);
          const allow = decision === 'allow' || decision === 'allow_session';
          resolved(permissionId, allow, decision, autoReason);
          resolve(allow ? (decision === 'allow_session' ? 'allow-session' : 'allow-once') : 'deny');
        };
        // The engine's own timeout aborts this signal, so the card disappearing
        // and the gate denying are one event rather than two racing ones — and
        // the reason on the signal is what says WHICH of the two happened.
        // Without it the countdown running out reached the renderer as
        // `aborted`, indistinguishable from the user pressing stop, and
        // `timed_out` had no producer anywhere despite the card being built to
        // show it (permissions-08, rpc-projector-18).
        const reason = (): 'aborted' | 'timed_out' =>
          signal.reason === PERMISSION_TIMEOUT_REASON ? 'timed_out' : 'aborted';
        function onAbort() {
          settle('deny', reason());
        }
        if (signal.aborted) {
          settle('deny', reason());
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        pending.set(permissionId, settle);
      }),

    respond: ({ permissionId, decision }) => {
      const settle = pending.get(permissionId);
      if (!settle) return false;
      settle(decision);
      return true;
    },

    drain: (reason) => {
      // Copied first: settling deletes from the map being walked.
      for (const [, settle] of [...pending]) settle('deny', reason);
    },
  };
}

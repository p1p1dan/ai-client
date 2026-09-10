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
  PermissionRequestKind,
  RuntimeEventDraft,
} from '../../shared/types/runtimeEvents.ts';
import type { PermissionConfig, ToolPermissionRequest } from '../plugins/permissions/index.ts';

/** The three answers this runtime can act on; `cancel` is not modelled. */
const OFFERED: PermissionDecisionId[] = ['allow', 'allow_session', 'deny'];

export interface PermissionPromptOptions {
  sessionId: string;
  cwd: string;
  emit: (event: RuntimeEventDraft) => void;
}

export interface PermissionPrompt {
  approve: NonNullable<PermissionConfig['approve']>;
  /** `false` when nothing was waiting on that id — see the RPC result's doc. */
  respond: (input: { permissionId: string; decision: PermissionDecisionId }) => boolean;
  /** Settle everything still parked, e.g. on dispose. Answers are denials. */
  drain: (reason: 'session_closed' | 'aborted') => void;
}

function kindOf(tool: string): PermissionRequestKind {
  if (tool === 'bash') return 'exec';
  if (tool === 'write' || tool === 'edit') return 'file_change';
  return 'tool';
}

/** One line naming what the tool does, in the terms of the decision. */
function describe(tool: string): string | undefined {
  switch (tool) {
    case 'bash':
      return '在工作区运行命令';
    case 'write':
      return '写入工作区文件';
    case 'edit':
      return '修改工作区文件';
    case 'read':
      return '读取文件内容';
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
    approve: (request, signal) =>
      new Promise((resolve) => {
        // The tool call id is the permission id, which is what the timeline
        // already assumes (`chatSessions.ts` calls it out): one gate per call.
        const permissionId = request.toolCallId;
        const detail = detailOf(request, options.cwd);
        const description = describe(request.tool);
        options.emit({
          type: 'permission.requested',
          sessionId: options.sessionId,
          payload: {
            permissionId,
            toolName: request.tool,
            ...(description ? { description } : {}),
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
            decisions: OFFERED,
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
        // and the gate denying are one event rather than two racing ones.
        function onAbort() {
          settle('deny', 'aborted');
        }
        if (signal.aborted) {
          settle('deny', 'aborted');
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

import type { PermissionDecisionId } from '../shared/types/runtimeEvents.ts';
import type { PendingKind } from './codexPending.ts';

/**
 * Codex decision dialects (S3 slice 4) — the translation between our
 * agent-neutral `PermissionDecisionId` and the words each approval kind
 * actually speaks on the wire.
 *
 * PURE. No state, no IO, no emit: the pending table owns the state and
 * `codexRuntime` owns the frames, so these rules can be driven straight from
 * captured params in a test.
 *
 * Deliberately exports NO user-facing copy. `src/agent-host` is a separate
 * program that the renderer cannot import (see `tsconfig.web.json` / the same
 * note on `attachmentLimits.ts`), so a `DECISION_LABELS` here would either be
 * unreachable from the card or force a boundary violation. Button text lives in
 * `questionCardModel.ts`; this file only ever deals in ids and wire values.
 *
 * Every value is pinned against the binary's own generated schema
 * (`__tests__/fixtures/codex/codex-approval-schema.json`) by
 * `codexDecisions.test.ts`, in both directions.
 */

const PERMISSION_DECISION_IDS: readonly PermissionDecisionId[] = [
  'allow',
  'allow_session',
  'deny',
  'cancel',
];

/**
 * Type guard for values arriving from the renderer over IPC, where `decision`
 * is whatever the payload happened to carry. An unknown word must be DROPPED by
 * the caller rather than forwarded: a decision we cannot map has no safe
 * meaning, and guessing one is how "allow" gets sent for a word nobody modelled.
 */
export function isPermissionDecisionId(value: unknown): value is PermissionDecisionId {
  return (
    typeof value === 'string' && (PERMISSION_DECISION_IDS as readonly string[]).includes(value)
  );
}

/**
 * The two live dialects. They currently hold the same four strings, and they
 * are still two tables on purpose: the S2 design's "same four" claim is false
 * for the SET of decisions each kind may offer (exec adds two object variants,
 * file_change has none), so folding them into one constant would encode an
 * equality the contract does not promise.
 *
 * [契约 codex-approval-schema.json: CommandExecutionApprovalDecision]
 * ('decline' additionally [实测]: the probe sent it and the server accepted it,
 * the turn continuing normally.)
 */
const EXEC_DIALECT: Readonly<Record<PermissionDecisionId, string>> = {
  allow: 'accept',
  allow_session: 'acceptForSession',
  deny: 'decline',
  cancel: 'cancel',
};

/** [契约 codex-approval-schema.json: FileChangeApprovalDecision] — four string variants, no object ones. */
const FILE_CHANGE_DIALECT: Readonly<Record<PermissionDecisionId, string>> = {
  allow: 'accept',
  allow_session: 'acceptForSession',
  deny: 'decline',
  cancel: 'cancel',
};

/**
 * `null` = this kind has no decision vocabulary in this build.
 *
 * `approval_permissions` and `elicitation` are answered by the fail-safe bodies
 * in `codexPending.defaultReplyFor`, never by a user decision — slice 4 refuses
 * them at the door instead of showing a card (spec §2.5). Reaching this file
 * with one of them is a caller bug, and a `null` that lands the caller in its
 * fail-safe deny is the honest answer; inventing a field name would produce a
 * frame that looks answered and grants nothing predictable.
 *
 * The legacy `ReviewDecision` dialect (`applyPatchApproval` /
 * `execCommandApproval`) is NOT modelled this round (spec L5): those methods are
 * not registered, so no entry can carry their kind.
 */
function dialectFor(kind: PendingKind): Readonly<Record<PermissionDecisionId, string>> | null {
  switch (kind) {
    case 'approval_exec':
      return EXEC_DIALECT;
    case 'approval_file_change':
      return FILE_CHANGE_DIALECT;
    case 'question':
    case 'approval_permissions':
    case 'elicitation':
      return null;
    default: {
      // Exhaustiveness: a new PendingKind must state its dialect (or its
      // absence) here rather than silently inheriting one.
      const unreachable: never = kind;
      throw new Error(`no decision dialect for pending kind ${String(unreachable)}`);
    }
  }
}

/**
 * Our id -> the word this kind expects on the wire. `null` = not mappable, and
 * the caller must degrade to a DENY (never to an allow, never to silence).
 *
 * The runtime type is `PermissionDecisionId`, but the own-property check is
 * deliberate: the value can originate from an IPC payload, and a prototype key
 * such as `'toString'` would otherwise resolve to an inherited function.
 */
export function toWireDecision(kind: PendingKind, id: PermissionDecisionId): string | null {
  const dialect = dialectFor(kind);
  if (!dialect) return null;
  if (!Object.hasOwn(dialect, id)) return null;
  return dialect[id] ?? null;
}

export interface OfferedDecisions {
  /** Buttons to show, in the server's own order. Always contains `deny`. */
  decisions: PermissionDecisionId[];
  /** How many offered decisions this build did not model (spec §0.2-6). */
  omitted: number;
}

/**
 * The historical pair. Used when the server said nothing about which decisions
 * to present — which is NOT the same as "no choices": file_change approval
 * params carry no `availableDecisions` field at all [契约 + 实测], so this is
 * that kind's normal path, not an error path.
 */
const FALLBACK_DECISIONS: readonly PermissionDecisionId[] = ['allow', 'deny'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reverseDialect(kind: PendingKind): Map<string, PermissionDecisionId> {
  const dialect = dialectFor(kind);
  const reverse = new Map<string, PermissionDecisionId>();
  if (!dialect) return reverse;
  for (const id of PERMISSION_DECISION_IDS) {
    reverse.set(dialect[id], id);
  }
  return reverse;
}

/**
 * `availableDecisions` -> the buttons the card may show.
 *
 * Four rules, each of which was a real defect in the first draft:
 *
 *  1. ORDER IS THE SERVER'S. The contract calls the field an "Ordered list of
 *     decisions the client may present", so re-sorting it overrides a
 *     presentation order the server chose on purpose.
 *  2. `omitted` counts only what we could NOT map — unknown strings and the
 *     object variants ("approve and persist a rule", spec L2). A repeated item
 *     we DO understand is de-duplicated and must not be counted, otherwise
 *     `["accept","accept","cancel"]` would tell the user a choice is missing
 *     when none is.
 *  3. `deny` is ALWAYS offered, inserted when the server did not list it. The
 *     one real exec frame we hold offers `accept / {object} / cancel`, and a
 *     card built strictly from it would have no plain Deny at all — only
 *     "refuse and kill the turn". `availableDecisions` is a suggestion, not a
 *     whitelist: `decline` is in the response schema and was accepted on the
 *     wire [实测]. Placement: immediately before `cancel` when there is one,
 *     otherwise last, so the two refusals read in increasing severity.
 *  4. `cancel` appears ONLY when the server offered it. It aborts the turn; we
 *     do not add that button on our own authority.
 *
 * An empty array is left as an empty array (deny-only card), not treated as the
 * fallback: "the server listed nothing" is a statement, and answering it by
 * synthesising an Allow button would be us inventing the permissive option.
 */
export function readOfferedDecisions(kind: PendingKind, params: unknown): OfferedDecisions {
  const offered = isRecord(params) ? params.availableDecisions : undefined;
  if (!Array.isArray(offered)) {
    return { decisions: [...FALLBACK_DECISIONS], omitted: 0 };
  }

  const reverse = reverseDialect(kind);
  const decisions: PermissionDecisionId[] = [];
  let omitted = 0;
  for (const entry of offered) {
    const id = typeof entry === 'string' ? reverse.get(entry) : undefined;
    if (!id) {
      omitted += 1;
      continue;
    }
    if (decisions.includes(id)) continue;
    decisions.push(id);
  }

  if (!decisions.includes('deny')) {
    const cancelAt = decisions.indexOf('cancel');
    if (cancelAt >= 0) decisions.splice(cancelAt, 0, 'deny');
    else decisions.push('deny');
  }

  return { decisions, omitted };
}

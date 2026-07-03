// checks.ts — Move (pointer transition) gates and item state machine.

import type { Pointer, StateFile, ItemStatus, Tier, Proposal } from './schema.js';
import { POINTERS } from './schema.js';
import { lastLedgerTransition, lastDecideRelatedTransition } from './store.js';

export interface GateResult {
  ok: boolean;
  errors: string[];
}

export function nextPointer(current: Pointer): Pointer | null {
  const idx = POINTERS.indexOf(current);
  if (idx < 0 || idx >= POINTERS.length - 1) return null;
  return POINTERS[idx + 1];
}

// §5.1 structural check: the AI must have hand-written the previous transition's
// ledger entry before the next `move` is allowed to proceed. Checks structure
// only (does an entry exist ending at the current pointer?), never content.
export function checkLedgerCaughtUp(dir: string, state: StateFile): GateResult {
  const errors: string[] = [];
  if (state.history_stack.length <= 1) return { ok: true, errors };
  const last = lastLedgerTransition(dir);
  if (!last || last.to !== state.pointer) {
    errors.push(
      `ledger.md is not caught up: expected the last transition entry to end at '${state.pointer}', ` +
      `but found ${last ? `'${last.to}'` : 'no transition entries'}. Write the missing ledger.md transition entry first.`
    );
  }
  return { ok: errors.length === 0, errors };
}

// §5.2 Hard Gate 1 — entering `build` requires a non-empty --scope on THIS move
// (re-entry included, per design: scope is overwritten every time) and a
// non-empty spec_refs declared ahead of time via `spec-ref add`/`spec-ref none`.
export function checkGateBuild(scopeArg: string | undefined, specRefs: StateFile['spec_refs']): GateResult {
  const errors: string[] = [];
  if (!scopeArg || !scopeArg.trim()) {
    errors.push('scope is empty — pass --scope "<one-line problem/scope statement>" (required every time you move to build, including re-entry)');
  }
  if (!specRefs || specRefs.length === 0) {
    errors.push('spec_refs is empty — declare at least one via `spec-ref add` (or `spec-ref none --reason ...`) before moving to build');
  }
  return { ok: errors.length === 0, errors };
}

// §5.3 Hard Gate 1a — T3 only, on the specific decide -> build edge. The most
// recent decide-related ledger transition must be a decide -> decide self-loop
// whose Satisfied line carries the literal marker confirmed_by_user:true.
export function checkGateDesignReconfirm(dir: string, tier: Tier): GateResult {
  const errors: string[] = [];
  if (tier !== 'T3') return { ok: true, errors };
  const last = lastDecideRelatedTransition(dir);
  if (!last || last.from !== 'decide' || last.to !== 'decide' || !last.satisfied.includes('confirmed_by_user:true')) {
    errors.push(
      'T3 requires an explicit design reconfirmation before entering build: after getting the user\'s ' +
      'approval in conversation, hand-write a `decide -> decide` ledger.md transition whose Satisfied line ' +
      'contains the literal marker confirmed_by_user:true.'
    );
  }
  return { ok: errors.length === 0, errors };
}

// Archive readiness: Hard Gate 2 (user acceptance) already happened via `accept`
// — this only re-checks its durable evidence (lifecycle_status/pointer == done)
// plus the (unrelated) knowledge-processed flag.
export function checkArchiveReady(proposal: Proposal, state: StateFile | null): GateResult {
  const errors: string[] = [];
  if (proposal.lifecycle_status !== 'done') {
    errors.push(`lifecycle_status is '${proposal.lifecycle_status}', expected 'done'`);
  }
  if (proposal.tier !== 'T1' && (!state || state.pointer !== 'done')) {
    errors.push(`pointer is '${state?.pointer ?? 'unknown'}', expected 'done'`);
  }
  if (!proposal.knowledge_processed) {
    errors.push('Knowledge candidates not processed. Run `knowledge suggest` then `knowledge save` or `knowledge skip`.');
  }
  return { ok: errors.length === 0, errors };
}

// --- Item state machine (serial "one doing at a time" invariant; no DAG) ---

export const VALID_ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  todo: ['doing', 'cancelled'],
  doing: ['done', 'blocked', 'cancelled'],
  blocked: ['doing', 'cancelled'],
  done: [],
  cancelled: [],
};

export interface ItemTransitionResult {
  ok: boolean;
  error?: string;
}

export function canTransitionItem(state: StateFile, itemId: string, to: ItemStatus): ItemTransitionResult {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return { ok: false, error: `Item '${itemId}' not found` };
  const allowed = VALID_ITEM_TRANSITIONS[item.status];
  if (!allowed.includes(to)) {
    return { ok: false, error: `Cannot transition item from '${item.status}' to '${to}'` };
  }
  if (to === 'doing') {
    const current = state.items.find(i => i.status === 'doing');
    if (current && current.id !== itemId) {
      return { ok: false, error: `Serial violation: item '${current.id}' is already doing` };
    }
  }
  return { ok: true };
}

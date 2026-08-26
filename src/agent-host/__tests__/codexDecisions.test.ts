import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionDecisionId } from '../../shared/types/runtimeEvents.ts';
import { isPermissionDecisionId, readOfferedDecisions, toWireDecision } from '../codexDecisions.ts';
import type { PendingKind } from '../codexPending.ts';

/**
 * S3 slice 4 — the decision dialects (acceptance A1 / A2-pure / A3 / A4 / A23).
 *
 * Two evidence sources, and they answer different questions:
 *
 *  - `codex-approval-schema.json` — the binary's own generated schema. It is
 *    the only proof that the words we send exist at all, and the only way to
 *    notice a codex upgrade adding a variant we silently drop.
 *  - `codex-command-approval.jsonl` — the ONE real exec approval frame we hold.
 *    Its `availableDecisions` is `["accept", {object}, "cancel"]`: no plain
 *    "decline" anywhere, which is precisely the frame that made "offer whatever
 *    the server listed" produce a card whose only refusal kills the turn.
 *
 * The emit half of A2 (`permission.resolved.allow === false` and
 * `decision === 'deny'` after a downgrade) belongs to the runtime segment; what
 * is provable here is that the downgrade has a landing at all.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'codex');

const LIVE_KINDS: PendingKind[] = ['approval_exec', 'approval_file_change'];
const NO_DIALECT_KINDS: PendingKind[] = ['question', 'approval_permissions', 'elicitation'];
const ALL_IDS: PermissionDecisionId[] = ['allow', 'allow_session', 'deny', 'cancel'];

describe('A1 — toWireDecision hits the two live dialects verbatim', () => {
  const cases: Array<[PendingKind, PermissionDecisionId, string]> = [
    ['approval_exec', 'allow', 'accept'],
    ['approval_exec', 'allow_session', 'acceptForSession'],
    ['approval_exec', 'deny', 'decline'],
    ['approval_exec', 'cancel', 'cancel'],
    ['approval_file_change', 'allow', 'accept'],
    ['approval_file_change', 'allow_session', 'acceptForSession'],
    ['approval_file_change', 'deny', 'decline'],
    ['approval_file_change', 'cancel', 'cancel'],
  ];

  it.each(cases)('%s + %s -> %s', (kind, id, wire) => {
    expect(toWireDecision(kind, id)).toBe(wire);
  });

  it.each(
    NO_DIALECT_KINDS.flatMap((kind) => ALL_IDS.map((id) => [kind, id] as const))
  )('%s has no dialect, so %s maps to null', (kind, id) => {
    // Not "unknown": these kinds are refused at the door (spec §2.5) and are
    // answered by codexPending's fail-safe bodies. Returning a plausible word
    // here would let a caller build a frame that looks like a real decision.
    expect(toWireDecision(kind, id)).toBeNull();
  });
});

describe('A2 (pure half) — an unmappable decision has a deny to fall back to', () => {
  it.each(LIVE_KINDS)('%s can always express a plain deny', (kind) => {
    // The downgrade in `respondPermission` is `mapped === null ? 'deny' : id`.
    // It is only safe while deny itself maps; if it ever returned null the
    // runtime would fall back onto nothing.
    const deny = toWireDecision(kind, 'deny');
    expect(deny).toBe('decline');
    expect(['accept', 'acceptForSession']).not.toContain(deny);
  });

  it.each(LIVE_KINDS)('%s degrades an unknown id to the deny word, never to an accept', (kind) => {
    // A decision id from a future build (or a malformed IPC payload that got
    // past the guard) must not be forwarded and must not be guessed.
    const unknownId = 'allow_always' as PermissionDecisionId;
    const mapped = toWireDecision(kind, unknownId);
    expect(mapped).toBeNull();

    const effective: PermissionDecisionId = mapped === null ? 'deny' : unknownId;
    expect(effective).toBe('deny');
    expect(toWireDecision(kind, effective)).toBe('decline');
  });

  it('does not resolve inherited object keys as decisions', () => {
    // `dialect[id]` with an unguarded lookup would hand back Object.prototype's
    // method for this id and a truthy result would read as "mappable".
    expect(toWireDecision('approval_exec', 'toString' as PermissionDecisionId)).toBeNull();
    expect(toWireDecision('approval_exec', 'constructor' as PermissionDecisionId)).toBeNull();
  });
});

describe('isPermissionDecisionId', () => {
  it.each(ALL_IDS)('accepts %s', (id) => {
    expect(isPermissionDecisionId(id)).toBe(true);
  });

  it.each([
    ['a wire word rather than an id', 'accept'],
    ['the other wire refusal', 'decline'],
    ['wrong case', 'Allow'],
    ['empty string', ''],
    ['a prototype key', 'toString'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 0],
    ['an object', { decision: 'allow' }],
    ['an array', ['allow']],
  ])('rejects %s', (_label, value) => {
    expect(isPermissionDecisionId(value)).toBe(false);
  });
});

interface ApprovalFrame {
  dir: string;
  raw: { method?: string; id?: number; params?: Record<string, unknown> };
}

/**
 * The real exec approval params [实测]. The JSON-RPC id in this fixture is the
 * README's own inferred value and is not used here: this suite reads params
 * only, so nothing depends on the envelope.
 */
const realExecParams = (() => {
  const frames = readFileSync(path.join(FIXTURES, 'codex-command-approval.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ApprovalFrame);
  const frame = frames.find(
    (f) => f.dir === '<-' && f.raw.method === 'item/commandExecution/requestApproval'
  );
  if (!frame?.raw.params) throw new Error('fixture no longer holds an exec approval request');
  return frame.raw.params;
})();

describe('A3 — readOfferedDecisions, six readings of availableDecisions', () => {
  it('guards the fixture it is driven by', () => {
    // If the captured frame ever loses its object variant or its cancel, the
    // "mixed" case below stops testing what it claims to test.
    expect(realExecParams.availableDecisions).toEqual([
      'accept',
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['/bin/bash', '-lc', 'echo hi > probe_a.txt'],
        },
      },
      'cancel',
    ]);
  });

  it('absent -> the historical pair (file_change normal path)', () => {
    expect(readOfferedDecisions('approval_file_change', { itemId: 'fc-1' })).toEqual({
      decisions: ['allow', 'deny'],
      omitted: 0,
    });
  });

  it('null -> the historical pair', () => {
    expect(readOfferedDecisions('approval_exec', { availableDecisions: null })).toEqual({
      decisions: ['allow', 'deny'],
      omitted: 0,
    });
  });

  it.each([
    ['a string', 'accept'],
    ['a number', 3],
    ['an object', { accept: true }],
  ])('a non-array (%s) -> the historical pair', (_label, offered) => {
    expect(readOfferedDecisions('approval_exec', { availableDecisions: offered })).toEqual({
      decisions: ['allow', 'deny'],
      omitted: 0,
    });
  });

  it('all-object items -> deny only, and every one of them counted as omitted', () => {
    expect(
      readOfferedDecisions('approval_exec', {
        availableDecisions: [
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } },
          { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow' } } },
        ],
      })
    ).toEqual({ decisions: ['deny'], omitted: 2 });
  });

  it('the real mixed frame -> allow/deny/cancel with the object variant omitted', () => {
    // The point of the whole rule: the server offered accept + a rule-persisting
    // variant + cancel. Rendered literally that is "Allow" and "Deny and stop",
    // so refusing one command would have meant killing the turn.
    expect(readOfferedDecisions('approval_exec', realExecParams)).toEqual({
      decisions: ['allow', 'deny', 'cancel'],
      omitted: 1,
    });
  });

  it('a repeated recognised item is de-duplicated but NOT counted as omitted', () => {
    // Negative control for the first draft's `omitted = raw.length - kept.length`,
    // which reported a missing choice that was never missing.
    expect(
      readOfferedDecisions('approval_exec', {
        availableDecisions: ['accept', 'accept', 'cancel'],
      })
    ).toEqual({ decisions: ['allow', 'deny', 'cancel'], omitted: 0 });
  });
});

/** Every permutation of every non-empty subset of the four wire words: 64 inputs. */
function permutedSubsets<T>(pool: readonly T[]): T[][] {
  const out: T[][] = [];
  const walk = (chosen: T[], rest: T[]): void => {
    if (chosen.length > 0) out.push([...chosen]);
    rest.forEach((item, index) => {
      walk([...chosen, item], [...rest.slice(0, index), ...rest.slice(index + 1)]);
    });
  };
  walk([], [...pool]);
  return out;
}

describe('A4 — the three invariants hold over every offered ordering', () => {
  const WIRE_WORDS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;
  const WIRE_TO_ID: Record<(typeof WIRE_WORDS)[number], PermissionDecisionId> = {
    accept: 'allow',
    acceptForSession: 'allow_session',
    decline: 'deny',
    cancel: 'cancel',
  };
  const inputs = permutedSubsets(WIRE_WORDS);

  it('covers all 64 orderings', () => {
    expect(inputs.length).toBe(64);
  });

  it.each(LIVE_KINDS)('%s: deny always present, order kept, cancel only if offered', (kind) => {
    for (const offered of inputs) {
      const { decisions, omitted } = readOfferedDecisions(kind, {
        availableDecisions: offered,
      });
      const label = `${kind} <- ${JSON.stringify(offered)}`;

      // 1. a plain refusal is always on the card
      expect(decisions, label).toContain('deny');
      // 2. nothing was dropped: every word here is modelled
      expect(omitted, label).toBe(0);
      expect(new Set(decisions).size, label).toBe(decisions.length);
      // 3. cancel is the server's to offer, never ours to add
      expect(decisions.includes('cancel'), label).toBe(offered.includes('cancel'));

      // 4. the server's relative order survives, with deny inserted where the
      //    rule says and nowhere else
      const fromServer = offered.map((word) => WIRE_TO_ID[word]);
      if (fromServer.includes('deny')) {
        expect(decisions, label).toEqual(fromServer);
      } else {
        const denyAt = decisions.indexOf('deny');
        const cancelAt = decisions.indexOf('cancel');
        if (cancelAt >= 0) expect(denyAt, label).toBe(cancelAt - 1);
        else expect(denyAt, label).toBe(decisions.length - 1);
        expect(
          decisions.filter((id) => id !== 'deny'),
          label
        ).toEqual(fromServer);
      }
    }
  });

  it.each(LIVE_KINDS)('%s: unknown words are counted, never rendered', (kind) => {
    const { decisions, omitted } = readOfferedDecisions(kind, {
      availableDecisions: ['accept', 'approved', 'timed_out', 42, null, 'cancel'],
    });
    // `approved` / `timed_out` belong to the legacy ReviewDecision dialect: a
    // word from the wrong dialect must not resolve, or slice 4 would send a
    // legacy answer to a v2 request.
    expect(decisions).toEqual(['allow', 'deny', 'cancel']);
    expect(omitted).toBe(4);
  });

  it('an empty list is a deny-only card, not the historical pair', () => {
    // "The server listed nothing" is a statement; answering it by synthesising
    // an Allow would invent the permissive option. Absence of the FIELD is the
    // fallback path, an empty array is not.
    expect(readOfferedDecisions('approval_exec', { availableDecisions: [] })).toEqual({
      decisions: ['deny'],
      omitted: 0,
    });
  });

  it('a kind with no dialect can still only produce a refusal', () => {
    expect(
      readOfferedDecisions('approval_permissions', { availableDecisions: ['accept', 'cancel'] })
    ).toEqual({ decisions: ['deny'], omitted: 2 });
  });
});

interface DecisionVariant {
  type: string;
  enum?: string[];
  required?: string[];
}
interface DecisionBlock {
  oneOf: DecisionVariant[];
}
interface ApprovalSchema {
  codexVersion: string;
  CommandExecutionApprovalDecision: DecisionBlock;
  FileChangeApprovalDecision: DecisionBlock;
  ReviewDecision: DecisionBlock;
}

const approvalSchema = JSON.parse(
  readFileSync(path.join(FIXTURES, 'codex-approval-schema.json'), 'utf8')
) as ApprovalSchema;

function stringVariants(block: DecisionBlock): string[] {
  return block.oneOf.filter((v) => v.type === 'string').flatMap((v) => v.enum ?? []);
}

function objectVariants(block: DecisionBlock): string[] {
  return block.oneOf.filter((v) => v.type === 'object').flatMap((v) => v.required ?? []);
}

describe('A23 — the dialect tables are pinned to the generated contract, both ways', () => {
  it('the snapshot is usable at all', () => {
    // A snapshot that lost its oneOf would make every assertion below pass on
    // an empty set — the classic way a pinning test stops pinning.
    expect(approvalSchema.codexVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(approvalSchema.CommandExecutionApprovalDecision.oneOf.length).toBe(6);
    expect(approvalSchema.FileChangeApprovalDecision.oneOf.length).toBe(4);
    // 7 -> 8 with codex 0.149.1 (approved_mcp_policy_amendment). The two live
    // dialects did not move, which is the half that would have cost work.
    expect(approvalSchema.ReviewDecision.oneOf.length).toBe(8);
  });

  const blocks: Array<[PendingKind, DecisionBlock, string[]]> = [
    [
      'approval_exec',
      approvalSchema.CommandExecutionApprovalDecision,
      // Not modelled this round (spec L2): both persist a rule, and we have no
      // UI that could show what was persisted or take it back.
      ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'],
    ],
    ['approval_file_change', approvalSchema.FileChangeApprovalDecision, []],
  ];

  it.each(blocks)('%s: every word we send exists in the contract', (kind, block) => {
    const declared = stringVariants(block);
    for (const id of ALL_IDS) {
      expect(declared, `${kind}/${id}`).toContain(toWireDecision(kind, id));
    }
  });

  it.each(blocks)('%s: every string variant in the contract has an id', (kind, block) => {
    const ours = new Set(ALL_IDS.map((id) => toWireDecision(kind, id)));
    expect(new Set(stringVariants(block))).toEqual(ours);
  });

  it.each(
    blocks
  )('%s: the object variants are the ones declared unmodelled', (_kind, block, unmodelled) => {
    expect(objectVariants(block)).toEqual(unmodelled);
  });

  it('the two live dialects are pinned as DIFFERENT sets, not "the same four"', () => {
    // S2 recorded them as identical. The string halves match; the offer sets do
    // not, and that difference is why `omittedDecisionCount` exists.
    expect(stringVariants(approvalSchema.CommandExecutionApprovalDecision)).toEqual(
      stringVariants(approvalSchema.FileChangeApprovalDecision)
    );
    expect(objectVariants(approvalSchema.CommandExecutionApprovalDecision).length).toBe(2);
    expect(objectVariants(approvalSchema.FileChangeApprovalDecision).length).toBe(0);
  });

  it('the legacy ReviewDecision dialect is entirely unmodelled and shares no word', () => {
    // The contract nail for L5: the legacy methods are not registered, so no
    // entry can carry their kind — and if one ever does, none of our v2 words
    // would be valid for it, which is what this asserts.
    const legacyStrings = stringVariants(approvalSchema.ReviewDecision);
    const legacyObjects = objectVariants(approvalSchema.ReviewDecision);
    // `approved_mcp_policy_amendment` arrived with codex 0.149.1 (2026-08-26).
    // It is listed here because this assertion's job is to enumerate the legacy
    // vocabulary exhaustively — a new legacy word that silently slipped past
    // would weaken the "shares no word" claim below, which is the L5 nail.
    expect(legacyStrings).toEqual([
      'approved',
      'approved_for_session',
      'approved_mcp_policy_amendment',
      'timed_out',
      'abort',
    ]);
    expect(legacyObjects).toEqual([
      'approved_execpolicy_amendment',
      'network_policy_amendment',
      'denied',
    ]);

    const liveWords = new Set(
      LIVE_KINDS.flatMap((kind) => ALL_IDS.map((id) => toWireDecision(kind, id)))
    );
    for (const word of legacyStrings) {
      expect(liveWords).not.toContain(word);
    }
  });
});

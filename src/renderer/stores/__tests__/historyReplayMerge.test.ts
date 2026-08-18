import { beforeEach, describe, expect, it } from 'vitest';
import {
  mergeReplayedHistory,
  type ReplayMergeMessage,
  type ResumeSnapshot,
  resetResumeCandidatesForTests,
  snapshotResumeCandidates,
  takeResumeSnapshot,
} from '../historyReplayMerge';

/**
 * Round-6 Bug B v2: the guarded coverage walk that reconciles a
 * `session.history` replay with runtime echoes already in the bucket. The
 * v1 bare walk was refuted by both review tracks (it could eat a message
 * the user just sent, and after a second replay it matched the session tail
 * against early history rows); each case here pins one of the three guards
 * — resume watermark, match-required, snapshot-time tail anchor — or a
 * fold-eligibility rule. Crime-scene cases replicate the reviews' concrete
 * counterexamples.
 */

function msg(id: string, role: string, text: string): ReplayMergeMessage {
  return { id, role, blocks: [{ type: 'text', text }] };
}

const att = (kind: string, mediaType: string, name?: string) =>
  name ? { kind, mediaType, name } : { kind, mediaType };

/**
 * Runtime image-only echoes carry an EMPTY text block (`beginTurn` always
 * emits its delta); history rows carry no blocks at all. Both shapes must
 * match — the arms are tested separately, never averaged.
 */
function attMsg(
  id: string,
  role: string,
  attachments: readonly unknown[],
  blocks: readonly { type: string; text?: string }[] = []
): ReplayMergeMessage {
  return { id, role, blocks, attachments };
}

const ids = (messages: readonly ReplayMergeMessage[]) => messages.map((message) => message.id);

// `orderedIds` defaults to the candidate ids in argument order, which is
// exactly what every existing case already means; only the drift cases
// (N3/N4) and the hole cases (N1/N2/N7/N18/N20) pass an explicit order.
const snap = (
  candidateIds: readonly string[],
  anchorHistoryId: string | null = null,
  orderedIds: readonly string[] = candidateIds
): ResumeSnapshot => ({ candidateIds: new Set(candidateIds), anchorHistoryId, orderedIds });

const ok = (snapshot: ResumeSnapshot | null) => ({ historyReadFailed: false, snapshot });

describe('mergeReplayedHistory — guarded replay coverage (round-6 Bug B v2)', () => {
  it('folds the pre-resume echo of a turn the replay contains (crime scene)', () => {
    // First resume of a live-created session: nothing hydrated yet, so the
    // snapshot has no anchor and the walk starts at row 0.
    const bucket = [msg('user-t1', 'user', '你好')];
    const history = [msg('h1', 'user', '你好'), msg('h2', 'user', '[Request interrupted by user]')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(['user-t1'])));

    expect(ids(merged)).toEqual(['h1', 'h2']);
  });

  it('watermark: a post-resume message survives even when an old history row has the same text', () => {
    // Codex blocker counterexample: fresh send races the detached history
    // read; the echo is NOT in the resume snapshot and must never be eaten
    // by an older same-text row.
    const merged = mergeReplayedHistory(
      [msg('user-new', 'user', '继续')],
      [msg('h-old', 'user', '继续')],
      ok(snap([]))
    );
    expect(ids(merged)).toEqual(['h-old', 'user-new']);
  });

  it('watermark: null snapshot (stale replay / no resume seen) folds nothing', () => {
    const merged = mergeReplayedHistory(
      [msg('user-t1', 'user', '你好')],
      [msg('h1', 'user', '你好')],
      ok(null)
    );
    expect(ids(merged)).toEqual(['h1', 'user-t1']);
  });

  it('anchor: the cursor lower bound, not row eligibility, is what stops P1', () => {
    // Opus blocker P1: after a first replay the bucket is [h:*, ..., resend
    // echo]; the fresh replay does not contain the resend yet. v1 restarted
    // the cursor at row 0 and ate the resend. N5: the defence is `cursor =
    // anchorIndex + 1` (the scan region is EMPTY here) plus guard 3e's upper
    // bound (the resend sits at ordered index 2, past the anchor at 1);
    // guard 3b (`id ∈ candidateIds` never absorbs) is only defence in depth.
    const bucket = [
      msg('h:old-1', 'user', '你好'),
      msg('h:old-2', 'user', '[Request interrupted by user]'),
      msg('user-resend', 'user', '你好'),
    ];
    const history = [
      msg('h:old-1', 'user', '你好'),
      msg('h:old-2', 'user', '[Request interrupted by user]'),
    ];

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(['h:old-1', 'h:old-2', 'user-resend'], 'h:old-2'))
    );

    expect(ids(merged)).toEqual(['h:old-1', 'h:old-2', 'user-resend']);
    // No bubble may be lost: the resend is a real turn the user just made.
    expect(merged).toHaveLength(3);
  });

  it('G14 (slice-5 L6, pinned CURRENT behavior): a codex live turn duplicates and reorders on same-process resume', () => {
    // Codex live link puts a whole turn on ONE assistant envelope (thinking +
    // tool_call/tool_result + final text), which is never fold-eligible; the
    // codex reprojection carries only userMessage/agentMessage [实测, fixtures
    // README S5]. So on a same-process resume the user echo folds, but the
    // live assistant message is KEPT and appended AFTER all history rows:
    // the final answer appears twice and the reasoning/tool content ends up
    // BELOW the reprojected final answer. Both review tracks flagged this
    // independently; it is registered as L6 (agent-agnostic merge policy ×
    // codex message shape), not fixed in slice 5 — this test is the pin that
    // makes the behavior a documented fact instead of a field surprise.
    const bucket: ReplayMergeMessage[] = [
      msg('codex-user-01a003a5', 'user', 'run the probe'),
      {
        id: 'codex-asst-s1-t1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', text: 'planning' },
          { type: 'tool_call', text: 'echo u2a-probe' },
          { type: 'tool_result', text: 'u2a-probe' },
          { type: 'text', text: 'DONE' },
        ],
      },
    ];
    const history = [
      msg('h:codex:T:turn-1:item-1', 'user', 'run the probe'),
      msg('h:codex:T:turn-1:item-2', 'assistant', 'DONE'),
    ];

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(['codex-user-01a003a5', 'codex-asst-s1-t1']))
    );

    expect(ids(merged)).toEqual([
      'h:codex:T:turn-1:item-1',
      'h:codex:T:turn-1:item-2',
      'codex-asst-s1-t1',
    ]);
  });

  it('anchor: a whole unflushed tail turn survives a second replay (P2)', () => {
    const bucket = [
      msg('h:t1u', 'user', '继续'),
      msg('h:t1a', 'assistant', '好的'),
      msg('user-t2', 'user', '继续'),
      msg('asst-t2', 'assistant', '好的'),
    ];
    const history = [msg('h:t1u', 'user', '继续'), msg('h:t1a', 'assistant', '好的')];

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(['h:t1u', 'h:t1a', 'user-t2', 'asst-t2'], 'h:t1a'))
    );

    expect(ids(merged)).toEqual(['h:t1u', 'h:t1a', 'user-t2', 'asst-t2']);
  });

  it('anchor: once the replay includes the tail turn, its echoes fold past the anchor', () => {
    const bucket = [
      msg('h:t1u', 'user', '继续'),
      msg('h:t1a', 'assistant', '好的'),
      msg('user-t2', 'user', '继续'),
      msg('asst-t2', 'assistant', '好的'),
    ];
    const history = [
      msg('h:t1u', 'user', '继续'),
      msg('h:t1a', 'assistant', '好的'),
      msg('h:t2u', 'user', '继续'),
      msg('h:t2a', 'assistant', '好的'),
    ];

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(['h:t1u', 'h:t1a', 'user-t2', 'asst-t2'], 'h:t1a'))
    );

    expect(ids(merged)).toEqual(['h:t1u', 'h:t1a', 'h:t2u', 'h:t2a']);
  });

  it('anchor: folding is disabled when the anchored row vanished from the replay', () => {
    // Round-6 verify blocker: a truncated read window (protocol-legal
    // success, `truncated: true`) can evict the anchor row. Restarting at
    // row 0 would match the tail candidate against an UNRELATED early
    // same-text row — loss. Without a cursor the replay must fold nothing:
    // the candidate survives, only the stale h:* rows are replaced.
    const bucket = [msg('h:gone', 'user', 'rewritten away'), msg('user-t1', 'user', '你好')];
    const history = [msg('h:new', 'user', '你好')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(['h:gone', 'user-t1'], 'h:gone')));

    expect(ids(merged)).toEqual(['h:new', 'user-t1']);
  });

  it('conserves count for legitimate same-text sends — one history row folds one echo', () => {
    const doubled = mergeReplayedHistory(
      [msg('echo-1', 'user', '你好'), msg('echo-2', 'user', '你好')],
      [msg('h1', 'user', '你好'), msg('h2', 'user', 'marker'), msg('h3', 'user', '你好')],
      ok(snap(['echo-1', 'echo-2']))
    );
    expect(ids(doubled)).toEqual(['h1', 'h2', 'h3']);

    // Set-folding by (role, text) would also swallow echo-2 here; the
    // forward-only cursor keeps it because history holds only one copy.
    const single = mergeReplayedHistory(
      [msg('echo-1', 'user', 'hi'), msg('echo-2', 'user', 'hi')],
      [msg('h1', 'user', 'hi')],
      ok(snap(['echo-1', 'echo-2']))
    );
    expect(ids(single)).toEqual(['h1', 'echo-2']);
  });

  it('match-required: an unmatched candidate (JSONL tail not flushed) is kept, never deleted', () => {
    const merged = mergeReplayedHistory(
      [msg('echo-a', 'user', 'A'), msg('echo-b', 'user', 'B')],
      [msg('h-a', 'user', 'A')],
      ok(snap(['echo-a', 'echo-b']))
    );
    expect(ids(merged)).toEqual(['h-a', 'echo-b']);
  });

  it('walks the cursor forward only — never re-matches behind a prior hit', () => {
    const merged = mergeReplayedHistory(
      [msg('echo-b', 'user', 'B'), msg('echo-a', 'user', 'A')],
      [msg('h-a', 'user', 'A'), msg('h-b', 'user', 'B')],
      ok(snap(['echo-a', 'echo-b']))
    );
    // echo-b matches h-b (cursor to end); echo-a finds nothing after it.
    expect(ids(merged)).toEqual(['h-a', 'h-b', 'echo-a']);
  });

  it('read failure short-circuits — snapshot or not, nothing runtime is dropped', () => {
    const merged = mergeReplayedHistory(
      [msg('h:stale', 'user', 'old'), msg('user-t1', 'user', '你好')],
      [msg('h1', 'user', '你好')],
      { historyReadFailed: true, snapshot: snap(['user-t1']) }
    );
    expect(ids(merged)).toEqual(['h1', 'user-t1']);
  });

  it('empty history short-circuits — runtime fully kept, stale h:* still dropped', () => {
    const merged = mergeReplayedHistory(
      [msg('h:stale', 'user', 'old'), msg('user-t1', 'user', '你好')],
      [],
      ok(snap(['user-t1']))
    );
    expect(ids(merged)).toEqual(['user-t1']);
  });

  it('replacement-folds a message carrying attachments — runtime copy replaces the history row (M1)', () => {
    const withAttachment: ReplayMergeMessage = {
      id: 'user-att',
      role: 'user',
      blocks: [{ type: 'text', text: 'look at this' }],
      attachments: [{ kind: 'image' }],
    };
    // N17: the history row has NO attachments on purpose. Fold identity is
    // TIERED, not conjoined: a message with text matches on text alone, so a
    // history row that recovered no attachment metadata (foreign Host, older
    // JSONL, a carrier this reader cannot see) still folds. Conjoining
    // attachments into the text identity would turn this contract red.
    const historyRow = msg('h1', 'user', 'look at this');
    expect(historyRow.attachments).toBeUndefined();

    const merged = mergeReplayedHistory([withAttachment], [historyRow], ok(snap(['user-att'])));

    // The runtime copy (with attachments) replaces the history row at its
    // position — no duplication, attachment metadata preserved.
    expect(ids(merged)).toEqual(['user-att']);
    expect(merged[0]?.attachments).toEqual([{ kind: 'image' }]);
  });

  it('keeps attachment message when no history match exists — fail-open to duplication', () => {
    const withAttachment: ReplayMergeMessage = {
      id: 'user-att',
      role: 'user',
      blocks: [{ type: 'text', text: 'look at this' }],
      attachments: [{ kind: 'image' }],
    };

    const merged = mergeReplayedHistory(
      [withAttachment],
      [msg('h1', 'user', 'different text')],
      ok(snap(['user-att']))
    );

    expect(ids(merged)).toEqual(['h1', 'user-att']);
  });

  it('does not replacement-fold when attachments AND non-text blocks coexist', () => {
    const mixed: ReplayMergeMessage = {
      id: 'asst-mixed',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'result' }, { type: 'tool_call' }],
      attachments: [{ kind: 'image' }],
    };

    const merged = mergeReplayedHistory(
      [mixed],
      [msg('h1', 'assistant', 'result')],
      ok(snap(['asst-mixed']))
    );

    // Non-text blocks make it genuinely unfoldable — kept alongside history.
    expect(ids(merged)).toEqual(['h1', 'asst-mixed']);
  });

  it('never folds a message carrying non-text/thinking blocks — live cards would die (M2)', () => {
    const withPermission: ReplayMergeMessage = {
      id: 'asst-perm',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'I will read the file.' }, { type: 'permission_request' }],
    };

    const merged = mergeReplayedHistory(
      [withPermission],
      [msg('h1', 'assistant', 'I will read the file.')],
      ok(snap(['asst-perm']))
    );

    expect(ids(merged)).toEqual(['h1', 'asst-perm']);
  });

  it('never folds non user/assistant roles — error rows are not replayable (N4)', () => {
    const merged = mergeReplayedHistory(
      [msg('msg-error-1', 'error', 'boom')],
      [msg('h1', 'error', 'boom')],
      ok(snap(['msg-error-1']))
    );
    expect(ids(merged)).toEqual(['h1', 'msg-error-1']);
  });

  it('messages without coverage text and no attachments never participate in matching', () => {
    // N13: the opt-out early return fires only when the message has NEITHER
    // coverage text NOR attachments — both fixtures below are attachment-free,
    // so `foldIdentity` still returns null and nothing is matched.
    const toolOnly: ReplayMergeMessage = {
      id: 'user-tool',
      role: 'user',
      blocks: [{ type: 'tool_call' }],
    };
    const emptyText = msg('user-empty', 'user', '   ');

    const merged = mergeReplayedHistory(
      [toolOnly, emptyText],
      [msg('h1', 'user', 'anything'), msg('h2', 'user', '   ')],
      ok(snap(['user-tool', 'user-empty']))
    );

    expect(ids(merged)).toEqual(['h1', 'h2', 'user-tool', 'user-empty']);
  });

  it('requires matching roles — a user echo is never covered by an assistant row', () => {
    const merged = mergeReplayedHistory(
      [msg('user-x', 'user', 'x')],
      [msg('h1', 'assistant', 'x')],
      ok(snap(['user-x']))
    );
    expect(ids(merged)).toEqual(['h1', 'user-x']);
  });

  it('matches on concatenated text blocks only — tool/thinking blocks are ignored', () => {
    const historyAssistant: ReplayMergeMessage = {
      id: 'h1',
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: 'pondering' },
        { type: 'text', text: '答' },
        { type: 'tool_call' },
      ],
    };

    const merged = mergeReplayedHistory(
      [msg('asst-1', 'assistant', '答')],
      [historyAssistant],
      ok(snap(['asst-1']))
    );

    expect(ids(merged)).toEqual(['h1']);
  });

  it('is pure: inputs are not mutated and a new array is returned', () => {
    const bucket = [msg('user-t1', 'user', '你好')];
    const history = [msg('h1', 'user', '你好')];
    const bucketSnapshot = JSON.parse(JSON.stringify(bucket));
    const historySnapshot = JSON.parse(JSON.stringify(history));

    const merged = mergeReplayedHistory(bucket, history, ok(snap(['user-t1'])));

    expect(bucket).toEqual(bucketSnapshot);
    expect(history).toEqual(historySnapshot);
    expect(merged).not.toBe(bucket);
    expect(merged).not.toBe(history);
  });
});

/**
 * F11: the positional hole claim (guard 3d/3e) and the tiered fold identity.
 *
 * Two defects, one leaf module. HOLE A: once a replacement fold succeeds, the
 * folded row's id leaves the bucket, so the NEXT snapshot's anchor (last `h:*`
 * in the bucket) jumps PAST it — the runtime copy is stranded before the
 * cursor forever (producer P-1, self-inflicted). HOLE B: an image-only turn
 * has empty coverage text on both sides, so it never matched at all.
 *
 * Fixtures marked "constructed" are negative controls: they pin shapes that
 * must be REFUSED, so they are allowed to be unproducible.
 */
describe('mergeReplayedHistory — F11 positional hole claim + tiered identity', () => {
  // §3.2 flagship, producible: two image+text echoes were folded last round,
  // so history rows h:u2 / h:u3 are the holes E1003 / E1005 dug themselves.
  const flagshipHistory = (): ReplayMergeMessage[] => [
    msg('h:u1', 'user', 'A first'),
    msg('h:a1', 'assistant', 'ok'),
    msg('h:u2', 'user', 'B look at this'),
    msg('h:a2', 'assistant', 'sure'),
    msg('h:u3', 'user', 'C and this'),
    msg('h:a3', 'assistant', 'right'),
    msg('h:u4', 'user', 'D later'),
    msg('h:a4', 'assistant', 'done'),
  ];
  const echoB = (): ReplayMergeMessage =>
    attMsg(
      'E1003',
      'user',
      [att('image', 'image/png', 'a.png')],
      [{ type: 'text', text: 'B look at this' }]
    );
  const echoC = (): ReplayMergeMessage =>
    attMsg(
      'E1005',
      'user',
      [att('image', 'image/png', 'b.png')],
      [{ type: 'text', text: 'C and this' }]
    );
  /** = the previous merge's OUTPUT: history rows with the two echoes in place. */
  const flagshipBucket = (): ReplayMergeMessage[] => {
    const history = flagshipHistory();
    return [
      history[0] as ReplayMergeMessage,
      history[1] as ReplayMergeMessage,
      echoB(),
      history[3] as ReplayMergeMessage,
      echoC(),
      history[5] as ReplayMergeMessage,
      history[6] as ReplayMergeMessage,
      history[7] as ReplayMergeMessage,
    ];
  };
  const FLAGSHIP_IDS = ['h:u1', 'h:a1', 'E1003', 'h:a2', 'E1005', 'h:a3', 'h:u4', 'h:a4'];

  /** Image-only history row: no blocks, one unnamed attachment (Carrier A). */
  const historyImageRow = (id: string, mediaType = 'image/png', name?: string) =>
    attMsg(id, 'user', [att('image', mediaType, name)], []);
  const imageEcho = (
    id: string,
    name: string,
    blocks: readonly { type: string; text?: string }[] = [{ type: 'text', text: '' }]
  ) => attMsg(id, 'user', [att('image', 'image/png', name)], blocks);

  it('N1: an echo reclaims the positional hole it dug last round (crime scene, producible)', () => {
    const history = flagshipHistory();
    const bucket = flagshipBucket();

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(ids(bucket), 'h:a4', ids(bucket)))
    );

    expect(ids(merged)).toEqual(FLAGSHIP_IDS);
    expect(merged).toHaveLength(8);
    // INV-P2: the replacement lands at the matched index, not at the tail.
    expect(merged[2]?.id).toBe('E1003');
    expect(merged[4]?.id).toBe('E1005');
    expect(merged[2]?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'a.png' },
    ]);
  });

  it('N2: the fold is a fixed point across replays (INV-P3)', () => {
    const history = flagshipHistory();
    const first = mergeReplayedHistory(
      flagshipBucket(),
      history,
      ok(snap(FLAGSHIP_IDS, 'h:a4', FLAGSHIP_IDS))
    );

    // Feed the merge's own output back in as the next resume's bucket.
    const second = mergeReplayedHistory(
      first,
      flagshipHistory(),
      ok(snap(ids(first), 'h:a4', ids(first)))
    );

    expect(ids(second)).toEqual(FLAGSHIP_IDS);
    expect(ids(second)).toEqual(ids(first));
  });

  it('N3: a misaligned snapshot closes positional claims entirely (constructed drift)', () => {
    // A sibling-branch row lands mid-file BEFORE the anchor: the anchor now
    // sits at history index 8 but at ordered index 7, so index `i` no longer
    // names the same row on both sides. Guard 3d shuts the hole channel; the
    // forward scan starts past the anchor and finds nothing.
    const history = flagshipHistory();
    const drifted = [
      ...history.slice(0, 6),
      msg('h:branch', 'assistant', 'sibling'),
      ...history.slice(6),
    ];
    const bucket = flagshipBucket();

    const merged = mergeReplayedHistory(
      bucket,
      drifted,
      ok(snap(ids(bucket), 'h:a4', ids(bucket)))
    );

    expect(ids(merged)).toEqual([
      'h:u1',
      'h:a1',
      'h:u2',
      'h:a2',
      'h:u3',
      'h:a3',
      'h:branch',
      'h:u4',
      'h:a4',
      'E1003',
      'E1005',
    ]);
    expect(merged).toHaveLength(11);
    // Nothing was replaced: history row 2 is still the history row.
    expect(merged[2]?.id).toBe('h:u2');
  });

  it('N4: a renumbered old row never eats the resend (constructed id drift)', () => {
    // B-Blocker 2: `h:old-1` came back as `s-7`, so it looks "new" to this
    // replay. The cursor lower bound (anchor + 1) and guard 3e's upper bound
    // both keep it out of reach; per-row eligibility alone would eat the
    // resend (measured on the v1 bench: 3 bubbles -> 2).
    const bucket = [
      msg('h:old-1', 'user', '你好'),
      msg('h:old-2', 'user', '[Request interrupted by user]'),
      msg('user-resend', 'user', '你好'),
    ];
    const history = [
      msg('s-7', 'user', '你好'),
      msg('h:old-2', 'user', '[Request interrupted by user]'),
    ];

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(ids(bucket), 'h:old-2', ids(bucket)))
    );

    expect(ids(merged)).toEqual(['s-7', 'h:old-2', 'user-resend']);
    expect(merged).toHaveLength(3);
  });

  it('N6: an image-only echo folds into the fresh post-anchor tail (both block shapes)', () => {
    for (const blocks of [[{ type: 'text', text: '' }], []]) {
      const history = [
        msg('h:p1', 'user', 'prompt one'),
        msg('h:p2', 'assistant', 'answer one'),
        historyImageRow('h:new'),
      ];
      const bucket = [
        history[0] as ReplayMergeMessage,
        history[1] as ReplayMergeMessage,
        imageEcho('E-img', 'a.png', blocks),
      ];

      const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:p2')));

      expect(ids(merged)).toEqual(['h:p1', 'h:p2', 'E-img']);
      expect(merged[2]?.attachments).toEqual([
        { kind: 'image', mediaType: 'image/png', name: 'a.png' },
      ]);
    }
  });

  it('N7: an image-only echo reclaims its own hole once the anchor moved past it', () => {
    const history = [
      msg('h:p1', 'user', 'prompt one'),
      msg('h:p2', 'assistant', 'answer one'),
      historyImageRow('h:new'),
      msg('h:r', 'assistant', 'later reply'),
    ];
    const bucket = [
      history[0] as ReplayMergeMessage,
      history[1] as ReplayMergeMessage,
      imageEcho('E-img', 'a.png'),
      history[3] as ReplayMergeMessage,
    ];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:r', ids(bucket))));

    expect(ids(merged)).toEqual(['h:p1', 'h:p2', 'E-img', 'h:r']);
    expect(merged).toHaveLength(4);
  });

  it('N8: without an anchor the attachment tier never folds (CE-B1, loss direction)', () => {
    const history = [historyImageRow('h:A')];
    const bucket = [imageEcho('E_B', 'b.png')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(['E_B'], null)));

    expect(ids(merged)).toEqual(['h:A', 'E_B']);
    expect(merged).toHaveLength(2);
  });

  it('N9: two same-identity history rows and no anchor — still nothing folds (CE-B2)', () => {
    const history = [historyImageRow('h:x1'), historyImageRow('h:x2')];
    const bucket = [imageEcho('user-s-3001', 'shot.png')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(['user-s-3001'], null)));

    expect(ids(merged)).toEqual(['h:x1', 'h:x2', 'user-s-3001']);
  });

  it('N10: mediaType is part of the attachment identity — png never folds into jpeg', () => {
    const history = [msg('h:anchor', 'user', 'anchor row'), historyImageRow('h:j', 'image/jpeg')];
    const bucket = [history[0] as ReplayMergeMessage, imageEcho('E-img', 'a.png')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'h:j', 'E-img']);
  });

  it('N11: a NAMED history image row is Carrier B and never absorbs our echo', () => {
    const history = [
      msg('h:anchor', 'user', 'anchor row'),
      historyImageRow('h:foreign', 'image/png', 'foreign.png'),
    ];
    const bucket = [history[0] as ReplayMergeMessage, imageEcho('E-img', 'a.png')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'h:foreign', 'E-img']);
  });

  it('N12: a history row with no text and no attachments absorbs nothing (constructed)', () => {
    const history: ReplayMergeMessage[] = [
      msg('h:anchor', 'user', 'anchor row'),
      { id: 'h:empty', role: 'user', blocks: [] },
    ];
    const bucket = [history[0] as ReplayMergeMessage, imageEcho('E-img', 'a.png')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'h:empty', 'E-img']);
  });

  it('N14: two same-identity image echoes fold one row each — count conserved', () => {
    const history = [
      msg('h:anchor', 'user', 'anchor row'),
      historyImageRow('h:i1'),
      historyImageRow('h:i2'),
    ];
    const bucket = [
      history[0] as ReplayMergeMessage,
      imageEcho('E1', 'one.png'),
      imageEcho('E2', 'two.png'),
    ];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'E1', 'E2']);
    expect(merged).toHaveLength(3);
  });

  it('N15: one history row and two image echoes — one folds, one is kept, none lost', () => {
    const history = [msg('h:anchor', 'user', 'anchor row'), historyImageRow('h:i1')];
    const bucket = [
      history[0] as ReplayMergeMessage,
      imageEcho('E1', 'one.png'),
      imageEcho('E2', 'two.png'),
    ];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'E1', 'E2']);
    expect(merged).toHaveLength(3);
  });

  it('N16: a replacement fold keeps the runtime attachment chips (tail arm and hole arm)', () => {
    const tailHistory = [
      msg('h:p1', 'user', 'prompt one'),
      msg('h:p2', 'assistant', 'answer one'),
      historyImageRow('h:new'),
    ];
    const tailBucket = [
      tailHistory[0] as ReplayMergeMessage,
      tailHistory[1] as ReplayMergeMessage,
      imageEcho('E-img', 'a.png'),
    ];
    const tail = mergeReplayedHistory(tailBucket, tailHistory, ok(snap(ids(tailBucket), 'h:p2')));

    expect(tail[2]?.id).toBe('E-img');
    expect(tail[2]?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'a.png' },
    ]);

    // Hole arm: the replacement must land at the matched index, not at the
    // end of the history array.
    const holeHistory = [...tailHistory, msg('h:r', 'assistant', 'later reply')];
    const holeBucket = [...tailBucket, holeHistory[3] as ReplayMergeMessage];
    const hole = mergeReplayedHistory(
      holeBucket,
      holeHistory,
      ok(snap(ids(holeBucket), 'h:r', ids(holeBucket)))
    );

    expect(hole[2]?.id).toBe('E-img');
    expect(hole[2]?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'a.png' },
    ]);
    expect(hole[3]?.id).toBe('h:r');
  });

  it('N18: the positional region and the scan region never collide (INV-P1)', () => {
    const history = [
      msg('h:anchor', 'user', 'anchor row'),
      msg('h:m', 'user', 'X'),
      msg('h:k', 'user', 'X'),
    ];
    const bucket = [
      history[0] as ReplayMergeMessage,
      msg('W', 'user', 'W'),
      attMsg('E1', 'user', [att('image', 'image/png', '1.png')], [{ type: 'text', text: 'X' }]),
      attMsg('E2', 'user', [att('image', 'image/png', '2.png')], [{ type: 'text', text: 'X' }]),
    ];

    const merged = mergeReplayedHistory(
      bucket,
      history,
      ok(snap(ids(bucket), 'h:anchor', ids(bucket)))
    );

    expect(ids(merged)).toEqual(['h:anchor', 'E1', 'E2', 'W']);
    // Two replacements, two distinct keys, in scan order.
    expect(merged[1]?.id).toBe('E1');
    expect(merged[2]?.id).toBe('E2');
  });

  it('N19: the attachment tier still requires equal roles', () => {
    const history = [
      msg('h:anchor', 'user', 'anchor row'),
      attMsg('h:img', 'assistant', [att('image', 'image/png')], []),
    ];
    const bucket = [history[0] as ReplayMergeMessage, imageEcho('E-img', 'a.png')];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'h:img', 'E-img']);
  });

  it('N20: a settled history row is never absorbed — hole channel and scan channel', () => {
    // Hole arm (guard 3e condition 2, INV-P4): ordered index 0 does name this
    // echo, but the row now sitting there was in the bucket at snapshot time,
    // so it is already settled and must not be claimed.
    const holeHistory = [
      msg('h:settled', 'user', 'X'),
      msg('h:free', 'user', 'X'),
      msg('h:anchor', 'assistant', 'anchor row'),
    ];
    const holeBucket = [
      msg('E1', 'user', 'X'),
      holeHistory[0] as ReplayMergeMessage,
      holeHistory[2] as ReplayMergeMessage,
    ];

    const hole = mergeReplayedHistory(
      holeBucket,
      holeHistory,
      ok(snap(ids(holeBucket), 'h:anchor', ids(holeBucket)))
    );

    expect(ids(hole)).toEqual(['h:settled', 'h:free', 'h:anchor', 'E1']);

    // Scan arm (guard 3b, defence in depth): an already-hydrated row that
    // ends up AFTER the anchor in file order is still settled.
    const scanHistory = [msg('h:a', 'assistant', 'anchor row'), msg('h:b', 'user', 'X')];
    const scanBucket = [
      scanHistory[1] as ReplayMergeMessage,
      scanHistory[0] as ReplayMergeMessage,
      msg('E', 'user', 'X'),
    ];

    const scan = mergeReplayedHistory(
      scanBucket,
      scanHistory,
      ok(snap(ids(scanBucket), 'h:a', ids(scanBucket)))
    );

    expect(ids(scan)).toEqual(['h:a', 'h:b', 'E']);
  });

  it('N21: tiers never cross — a text message is not matched by an image row', () => {
    const history = [msg('h:anchor', 'user', 'anchor row'), historyImageRow('h:img')];
    const bucket = [
      history[0] as ReplayMergeMessage,
      msg('E-text', 'user', '[["image","image/png"]]'),
    ];

    const merged = mergeReplayedHistory(bucket, history, ok(snap(ids(bucket), 'h:anchor')));

    expect(ids(merged)).toEqual(['h:anchor', 'h:img', 'E-text']);
  });
});

describe('resume snapshot registry', () => {
  beforeEach(() => {
    resetResumeCandidatesForTests();
  });

  it('hands the snapshot to the matching requestId exactly once, with the anchor derived in order', () => {
    snapshotResumeCandidates('session-1', 'req-1', ['h:a', 'h:b', 'user-t1']);

    const first = takeResumeSnapshot('session-1', 'req-1');
    expect(first && [...first.candidateIds].sort()).toEqual(['h:a', 'h:b', 'user-t1']);
    expect(first?.anchorHistoryId).toBe('h:b');
    // Consumed: a duplicate replay of the same request folds nothing more.
    expect(takeResumeSnapshot('session-1', 'req-1')).toBeNull();
  });

  it('derives a null anchor when nothing was hydrated before the resume', () => {
    snapshotResumeCandidates('session-1', 'req-1', ['user-t1']);
    expect(takeResumeSnapshot('session-1', 'req-1')?.anchorHistoryId).toBeNull();
  });

  it('a stale requestId neither reads nor destroys the in-flight snapshot', () => {
    snapshotResumeCandidates('session-1', 'req-2', ['user-t1']);

    expect(takeResumeSnapshot('session-1', 'req-1')).toBeNull();
    // The matching replay that arrives later still gets its snapshot.
    expect(takeResumeSnapshot('session-1', 'req-2')).not.toBeNull();
  });

  it('a newer resume overwrites the previous snapshot; sessions are isolated', () => {
    snapshotResumeCandidates('session-1', 'req-1', ['user-a']);
    snapshotResumeCandidates('session-1', 'req-2', ['user-a', 'user-b']);
    snapshotResumeCandidates('session-2', 'req-9', ['other']);

    expect(takeResumeSnapshot('session-1', 'req-1')).toBeNull();
    const latest = takeResumeSnapshot('session-1', 'req-2');
    expect(latest && [...latest.candidateIds].sort()).toEqual(['user-a', 'user-b']);
    expect(takeResumeSnapshot('session-2', 'req-9')).not.toBeNull();
  });

  it('missing requestId on the history event yields no snapshot', () => {
    snapshotResumeCandidates('session-1', 'req-1', ['user-t1']);
    expect(takeResumeSnapshot('session-1', undefined)).toBeNull();
  });
});

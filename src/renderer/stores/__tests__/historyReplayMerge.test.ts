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

const ids = (messages: readonly ReplayMergeMessage[]) => messages.map((message) => message.id);

const snap = (
  candidateIds: readonly string[],
  anchorHistoryId: string | null = null
): ResumeSnapshot => ({ candidateIds: new Set(candidateIds), anchorHistoryId });

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

  it('anchor: a second replay never matches the resend against early history rows (P1)', () => {
    // Opus blocker P1: after a first replay the bucket is [h:*, ..., resend
    // echo]; the fresh replay does not contain the resend yet. v1 restarted
    // the cursor at row 0 and ate the resend.
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

  it('never folds a message carrying attachments — history rows cannot restate them (M1)', () => {
    const withAttachment: ReplayMergeMessage = {
      id: 'user-att',
      role: 'user',
      blocks: [{ type: 'text', text: 'look at this' }],
      attachments: [{ kind: 'image' }],
    };

    const merged = mergeReplayedHistory(
      [withAttachment],
      [msg('h1', 'user', 'look at this')],
      ok(snap(['user-att']))
    );

    expect(ids(merged)).toEqual(['h1', 'user-att']);
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

  it('messages without coverage text never participate in matching', () => {
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

import { describe, expect, it } from 'vitest';
import { LOOP_GUARD_SOURCE_KIND } from '../../dsh-host/loopGuard/constants.ts';
import { DSH_SOURCE_AICLIENT_RETRY } from '../dshHistory/types.ts';
import {
  DSH_NOTICE_CUSTOM_TYPE_PREFIX,
  dshNoticeText,
  dshSourceKind,
  dshTurnHeadText,
  dshTurnOrigin,
} from '../dshNotices.ts';

/**
 * dsh-rebase P1-4d1 (decisions 072 rules 3-4, 081, 099 rules 7-8; plan P1-7
 * shard 03 §6): one table for what the timeline makes of a DSH message nobody
 * typed. The live bridge and the history projection both read it.
 */

const text = (value: string) => [{ type: 'text', text: value }];

describe('dshTurnOrigin — the engine turns that get a head', () => {
  it('names the four sources that open a turn by themselves', () => {
    expect(dshTurnOrigin({ kind: 'goal', goalId: 'g', revision: 1, round: 3 }, 8)).toEqual({
      kind: 'goal',
      round: 3,
      maxRounds: 8,
    });
    expect(dshTurnOrigin({ kind: 'tool-jobs', form: 'notice', summary: 'bash x' })).toEqual({
      kind: 'job',
    });
    expect(
      dshTurnOrigin({
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'explore finished',
        senderSessionId: 'child-1',
      })
    ).toEqual({ kind: 'subagent', childSessionId: 'child-1' });
    expect(
      dshTurnOrigin({ kind: 'agent-message', form: 'relay', senderSessionId: 'child-2' })
    ).toEqual({ kind: 'agent-message', childSessionId: 'child-2' });
  });

  it('leaves the budget out when the log recorded none', () => {
    expect(dshTurnOrigin({ kind: 'goal', round: 1 })).toEqual({ kind: 'goal', round: 1 });
  });

  it('never heads a turn with a prompt, a reminder or model context', () => {
    for (const source of [
      { kind: 'user' },
      { kind: DSH_SOURCE_AICLIENT_RETRY, form: 'notice', summary: 'retry' },
      { kind: LOOP_GUARD_SOURCE_KIND, form: 'notice', summary: 'wrap up' },
      { kind: 'tool-goal', form: 'notice', summary: 'complete: x' },
      { kind: 'runtime-context', form: 'snapshot', sections: [] },
      undefined,
      'goal',
    ]) {
      expect(dshTurnOrigin(source), JSON.stringify(source)).toBeUndefined();
    }
  });
});

describe('dshTurnHeadText — what a head says', () => {
  it('is the one-line account, the relayed message, or nothing for a goal round', () => {
    expect(dshTurnHeadText({ kind: 'tool-jobs', summary: 'bash x exited 0' }, text('long'))).toBe(
      'bash x exited 0'
    );
    expect(dshTurnHeadText({ kind: 'agent-message', form: 'relay' }, text('found it'))).toBe(
      'found it'
    );
    expect(dshTurnHeadText({ kind: 'goal', round: 2 }, text('<goal_round>…'))).toBe('');
  });
});

describe('dshNoticeText — what a notice in the middle of a turn says', () => {
  it('shows the accounts of background work, by their summary', () => {
    expect(
      dshNoticeText({ kind: 'tool-jobs', form: 'notice', summary: 'bash x exited 0' }, text('..'))
    ).toBe('bash x exited 0');
    expect(
      dshNoticeText({ kind: 'subagent-settled', form: 'notice', summary: 'explore done' }, [])
    ).toBe('explore done');
    expect(dshNoticeText({ kind: 'agent-message', form: 'relay' }, text('a finding'))).toBe(
      'a finding'
    );
  });

  it("hides the goal tool's wrap-up, model changes, reminders and our own instructions", () => {
    for (const kind of [
      'tool-goal',
      'model-selection',
      'repeat-tool-reminder',
      'plan-mode',
      LOOP_GUARD_SOURCE_KIND,
      DSH_SOURCE_AICLIENT_RETRY,
    ]) {
      expect(dshNoticeText({ kind, form: 'notice', summary: 'x' }, text('x')), kind).toBe(
        undefined
      );
    }
  });

  it('hides model context and a goal round met mid-turn', () => {
    expect(dshNoticeText({ kind: 'goal', round: 1 }, text('<goal_round>'))).toBeUndefined();
    expect(dshNoticeText({ kind: 'agent-instructions', form: 'instructions' }, text('x'))).toBe(
      undefined
    );
    expect(dshNoticeText({ kind: 'user' }, text('typed'))).toBeUndefined();
  });

  it("shows an unknown producer's notice, so a later DSH's accounts do not vanish", () => {
    expect(dshNoticeText({ kind: 'dsh-new-thing', form: 'notice', summary: 'hello' }, [])).toBe(
      'hello'
    );
    expect(dshNoticeText({ kind: 'dsh-new-thing', form: 'notice' }, text('body'))).toBe('body');
    expect(dshNoticeText({ kind: 'dsh-new-thing', form: 'notice' }, [])).toBeUndefined();
  });

  it('names the live custom type by the source kind', () => {
    expect(`${DSH_NOTICE_CUSTOM_TYPE_PREFIX}${dshSourceKind({ kind: 'tool-jobs' })}`).toBe(
      'dsh:tool-jobs'
    );
    expect(dshSourceKind({})).toBeUndefined();
  });
});

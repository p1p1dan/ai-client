import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  deriveTurnEndNotice,
  turnEndNotesAfterWork,
  turnEndsWithoutReply,
} from '../turnEndNoticeModel';

/**
 * dsh-rebase P1-7e (problem 7, decision 140): the note a reopened turn that
 * saved no reply ends on. A failed turn says why in the words its live card
 * used, with the engine's sentence as evidence; the note is never a reply.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
const render = (view: ReturnType<typeof deriveTurnEndNotice>) =>
  zh(view.key, view.reasonKey ? { reason: zh(view.reasonKey) } : undefined);

describe('deriveTurnEndNotice', () => {
  it('[E2B-NOTE-FAILED] a failed turn names the kind of failure the history recorded', () => {
    const view = deriveTurnEndNotice({
      kind: 'failed',
      errorCode: 'PROVIDER_ERROR',
      error: 'P1-FAIL: the fake upstream failed this request',
    });
    expect(render(view)).toBe('这一轮没有完成：模型服务返回了错误，没有保存任何回复。');
    expect(view.detail).toBe('P1-FAIL: the fake upstream failed this request');
  });

  it('[E2B-NOTE-GATE] the gateway stream gate reads as its own card title', () => {
    const view = deriveTurnEndNotice({ kind: 'failed', errorCode: 'GATEWAY_STREAM_GATE' });
    expect(render(view)).toBe('这一轮没有完成：公司网关中断了这次回复，没有保存任何回复。');
    expect(view).not.toHaveProperty('detail');
  });

  it('[E2B-NOTE-UNKNOWN] no code, or one this build does not know: the plain note, the sentence kept', () => {
    expect(render(deriveTurnEndNotice({ kind: 'failed' }))).toBe(
      '这一轮没有完成，没有保存任何回复。'
    );
    const odd = deriveTurnEndNotice({ kind: 'failed', errorCode: 'SOMETHING_NEW', error: 'odd' });
    expect(render(odd)).toBe('这一轮没有完成，没有保存任何回复。');
    expect(odd.detail).toBe('odd');
  });

  it('[E2B-NOTE-ENGINE] the sentence stays out where the card itself would not print it', () => {
    // dsh_host_crashed's sentence is this app's own about its engine process.
    const view = deriveTurnEndNotice({
      kind: 'failed',
      errorCode: 'dsh_host_crashed',
      error: 'Worker exited (code=null signal=SIGKILL)',
    });
    expect(view).not.toHaveProperty('detail');
  });

  it('[E2B-NOTE-STOPPED] a stopped turn and a cut-off one say so, in the reader’s language', () => {
    expect(render(deriveTurnEndNotice({ kind: 'stopped' }))).toBe(
      '这一轮已停止，没有保存任何回复。'
    );
    expect(render(deriveTurnEndNotice({ kind: 'interrupted' }))).toBe(
      '这一轮中断了，没有保存任何回复。'
    );
    // English is the key itself.
    expect(translate('en', deriveTurnEndNotice({ kind: 'stopped' }).key)).toBe(
      'This turn was stopped. No reply was saved.'
    );
  });
});

describe('a note after saved work', () => {
  it('[E2B-NOTE-AFTER-WORK] drops 「没有保存任何回复」 when the turn saved something first', () => {
    const failed = deriveTurnEndNotice(
      { kind: 'failed', errorCode: 'PROVIDER_ERROR', error: 'boom' },
      { afterWork: true }
    );
    expect(render(failed)).toBe('这一轮没有完成：模型服务返回了错误。');
    expect(failed.detail).toBe('boom');
    expect(render(deriveTurnEndNotice({ kind: 'failed' }, { afterWork: true }))).toBe(
      '这一轮没有完成。'
    );
    expect(render(deriveTurnEndNotice({ kind: 'stopped' }, { afterWork: true }))).toBe(
      '这一轮已停止。'
    );
    expect(render(deriveTurnEndNotice({ kind: 'interrupted' }, { afterWork: true }))).toBe(
      '这一轮中断了。'
    );
  });

  it('[E2B-NOTE-AFTER-WORK-IDS] names only the notes that follow an assistant message with blocks', () => {
    const note = (id: string) => ({
      id,
      role: 'system',
      blocks: [{}],
      turnEnd: { kind: 'failed' as const },
    });
    expect([...turnEndNotesAfterWork([note('n1')])]).toEqual([]);
    expect([
      ...turnEndNotesAfterWork([
        { id: 'a0', role: 'assistant', blocks: [] },
        { id: 's0', role: 'system', blocks: [{}] },
        note('n1'),
        { id: 'a1', role: 'assistant', blocks: [{}] },
        note('n2'),
      ]),
    ]).toEqual(['n2']);
  });
});

describe('turnEndsWithoutReply', () => {
  it('is true only when the turn’s last message is such a note', () => {
    expect(turnEndsWithoutReply([{}, { turnEnd: { kind: 'failed' } }])).toBe(true);
    expect(turnEndsWithoutReply([{ turnEnd: { kind: 'failed' } }, {}])).toBe(false);
    expect(turnEndsWithoutReply([])).toBe(false);
  });
});

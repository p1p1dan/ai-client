import { zhTranslations } from '@shared/i18n';
import type { PiModelSyncFailure, PiModelSyncFailureKind } from '@shared/piModelConfig';
import { describe, expect, it } from 'vitest';
import {
  PI_MODEL_SYNC_DETAIL_LABEL,
  PI_MODEL_SYNC_NOTICE_VIEWS,
  piModelSyncNoticeView,
} from '../piModelSyncNoticeModel';

/**
 * The copy and the choice of button for "you signed in and your company's
 * models did not arrive".
 *
 * The rule under test is the one the field report asked for: a failure the
 * user can clear themselves gets a Retry, a failure about their ACCOUNT gets a
 * way back to the sign-in screen and no Retry at all — a button that cannot
 * work is worse than no button.
 */

function failure(kind: PiModelSyncFailureKind): PiModelSyncFailure {
  return { kind, error: 'management endpoint returned HTTP 500', at: 1_700_000_000_000 };
}

describe('piModelSyncNoticeView', () => {
  it('says nothing when the last managed sync worked', () => {
    expect(piModelSyncNoticeView({ managed: true, failure: null })).toBeNull();
  });

  it('says nothing on the local route, whatever was recorded', () => {
    // The local route never promised company models, so reporting a skipped
    // company sync would be reading the user's own setting back to them as a
    // fault. `credentials-disabled` is only ever produced there.
    expect(piModelSyncNoticeView({ managed: false, failure: failure('network') })).toBeNull();
    expect(
      piModelSyncNoticeView({ managed: false, failure: failure('credentials-disabled') })
    ).toBeNull();
    expect(
      piModelSyncNoticeView({ managed: true, failure: failure('credentials-disabled') })
    ).toBeNull();
  });

  it.each([
    ['network', 'retry'],
    ['server', 'retry'],
    ['response', 'retry'],
    ['unauthorized', 'sign-in'],
    ['credentials-missing', 'sign-in'],
  ] as const)('offers %s the %s action', (kind, action) => {
    const view = piModelSyncNoticeView({ managed: true, failure: failure(kind) });
    expect(view?.action).toBe(action);
    // Title, one sentence of cause, one sentence of next step — decision 019's
    // card shape. An empty field would render a blank line, not a card.
    expect(view?.title).toBeTruthy();
    expect(view?.message).toBeTruthy();
    expect(view?.hint).toBeTruthy();
  });

  it('gives the two account failures their own explanation', () => {
    // They share an action, and they are not the same problem: one is an
    // account the service refuses, the other an account that was never issued
    // a credential. Identical copy would send the user to the wrong question.
    const refused = piModelSyncNoticeView({ managed: true, failure: failure('unauthorized') });
    const never = piModelSyncNoticeView({ managed: true, failure: failure('credentials-missing') });
    expect(refused?.title).not.toBe(never?.title);
    expect(refused?.message).not.toBe(never?.message);
  });

  it('has a Chinese entry for every string it can put on screen', () => {
    // These reach `t()` as `t(view.title)`, so `i18nCoverage.test.ts` — which
    // scans for literal `t('…')` calls — cannot see them. Without this check a
    // missing entry would surface as English text in a Chinese UI, which is
    // exactly what T062 round-2 had to fix by hand.
    const keys = [
      PI_MODEL_SYNC_DETAIL_LABEL,
      ...Object.values(PI_MODEL_SYNC_NOTICE_VIEWS).flatMap((view) => [
        view.title,
        view.message,
        view.hint,
      ]),
    ];
    expect(keys.filter((key) => !(key in zhTranslations))).toEqual([]);
  });
});

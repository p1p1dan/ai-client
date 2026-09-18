/**
 * "Signing in worked, but your company's models did not arrive" — what to say,
 * and which way out to offer.
 *
 * ## The defect this answers
 *
 * `ipc/onboarding.ts` syncs the managed model catalog the moment a login
 * succeeds. When that sync failed it wrote ONE line to the main process
 * console and nothing else: the window was never told, so a user came through
 * the sign-in screen, landed in the app, opened the model menu and found it
 * empty — with no message, no reason, and no way to try again. On a clean
 * machine with no AI service of the user's own, that is the whole product
 * failing to start, and it is indistinguishable from the user having done
 * something wrong.
 *
 * ## Shape
 *
 * Decision 019 (runtime errors as guided cards) and `modelMissingError.ts`:
 * a title, one sentence of cause, one sentence of next step, and exactly ONE
 * button. Every string here is a DICTIONARY KEY, not display text — this is a
 * plain `.ts` with no translator in scope, so the component calls `t()` on
 * each field. `piModelSyncNotice.test.ts` asserts each key has a Chinese
 * entry, because the renderer-wide scan (`i18nCoverage.test.ts`) only sees a
 * translator call whose argument is a literal, and every call here passes a
 * field of the view instead.
 *
 * ## Why the classification is not done here
 *
 * `PiModelSyncFailureKind` is decided in Main at the point of failure. Reading
 * it rather than matching on `failure.error` is what keeps this module from
 * becoming a substring test against HTTP status text and `JSON.parse`
 * messages. The raw `error` reaches the screen, but only as a labelled
 * diagnostic line under the explanation — never as the explanation.
 */

import type { PiModelSyncFailure, PiModelSyncFailureKind } from '@shared/piModelConfig';

/**
 * The one control the card offers.
 *
 * `'retry'` — the failure can plausibly clear on its own, so trying again is a
 * real answer. `'sign-in'` — the account itself is the problem, and a retry
 * would fail identically every time; a button that cannot work is worse than
 * no button (the rule `modelMissingError.ts` already follows).
 */
export type PiModelSyncNoticeAction = 'retry' | 'sign-in';

export interface PiModelSyncNoticeView {
  title: string;
  /** One sentence: what happened, in the user's terms. */
  message: string;
  /** One sentence: what to do about it. */
  hint: string;
  action: PiModelSyncNoticeAction;
}

/** Label above the raw English diagnostic, so it reads as evidence to forward. */
export const PI_MODEL_SYNC_DETAIL_LABEL = 'Details to send to your administrator:';

export const PI_MODEL_SYNC_NOTICE_VIEWS: Record<
  Exclude<PiModelSyncFailureKind, 'credentials-disabled'>,
  PiModelSyncNoticeView
> = {
  network: {
    title: 'Your company models could not be loaded',
    message:
      'This app could not reach the model service, so none of the models your company provides are in the list yet.',
    hint: 'Check your network — or your company VPN — and then try again.',
    action: 'retry',
  },
  server: {
    title: 'Your company models could not be loaded',
    message:
      'The model service answered with an error, so none of the models your company provides are in the list yet.',
    hint: 'Try again in a moment. If it keeps failing, send the line below to your administrator.',
    action: 'retry',
  },
  response: {
    title: 'Your company models could not be loaded',
    message:
      'The model service answered with something this app could not read, so the model list is still empty.',
    hint: 'Try once more. If it fails the same way, this is a problem on the server — send the line below to your administrator.',
    action: 'retry',
  },
  unauthorized: {
    title: 'The model service turned down your account',
    // Worded so it is true on BOTH of this failure's paths. A refused account
    // still falls through to the catalog this build shipped with, so the menu
    // may well be full — of models the same account will be refused for the
    // moment a message is sent (see `ACCOUNT_SYNC_FAILURES` in
    // `services/piModelConfig`). Copy that said "no models were loaded" would
    // be visibly wrong next to a populated menu, and the user would then trust
    // neither the card nor the menu.
    message:
      'Signing in worked, but the model service refused this account. Anything still in the model list will be refused the same way when you send a message.',
    hint: 'Sign in again first. If that does not help, ask your administrator whether your account has model access.',
    action: 'sign-in',
  },
  'credentials-missing': {
    title: 'Your account did not receive a model credential',
    message:
      'Signing in worked, but this account came back without the credential the model service needs, so no company model could be loaded.',
    hint: 'Ask your administrator to enable model access for your account, then sign in again.',
    action: 'sign-in',
  },
};

export interface PiModelSyncNoticeInput {
  /** `PiModelManagementSettings.managed` — is this install on the managed route at all. */
  managed: boolean;
  /** `PiModelManagementSettings.lastFailure`. */
  failure: PiModelSyncFailure | null;
}

/**
 * The card to show, or `null` for "say nothing".
 *
 * Two silences, both deliberate:
 *
 *  - **No failure recorded.** The last sync came away with a catalog. A stale
 *    cache or the shipped baseline is not a failure by that measure — the user
 *    has models to work with, and the model menu's own status row already says
 *    the list may be out of date. Raising a card there would leave it lit on a
 *    working install, which is the `chatEmptyState.ts` complaint repeated.
 *  - **`managed === false`.** This install runs on the user's OWN
 *    configuration, by choice or by dev override, and it never promised
 *    company models. That is also the only route on which
 *    `'credentials-disabled'` can be produced, which is why this view has no
 *    arm for it: telling someone who picked "use my own setup" that a company
 *    sync was skipped would be reporting the setting back to them as a fault.
 */
export function piModelSyncNoticeView(input: PiModelSyncNoticeInput): PiModelSyncNoticeView | null {
  if (!input.managed) return null;
  const failure = input.failure;
  if (!failure) return null;
  if (failure.kind === 'credentials-disabled') return null;
  return PI_MODEL_SYNC_NOTICE_VIEWS[failure.kind] ?? PI_MODEL_SYNC_NOTICE_VIEWS.network;
}

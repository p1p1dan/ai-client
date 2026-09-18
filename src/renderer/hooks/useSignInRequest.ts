/**
 * "Take me to the sign-in screen" — the one handler behind every in-app
 * login/re-login affordance.
 *
 * ## The defect this replaces
 *
 * Each of those buttons used to do the same two lines inline: close whatever
 * popover it lived in, then `dispatchEvent(AUTH_OPEN_ONBOARDING_EVENT)`. The
 * event's only listener (Root) invalidated two queries and trusted the gate to
 * route. It cannot: `resolveGateDecision` returns `app` whenever Main's entry
 * latch is set, and the latch is set for as long as the user is inside the app,
 * so re-querying produced the identical decision every time. On a machine
 * running `Use my own setup` there was not even an error to notice —
 * `resolveSpawnGateDecision` short-circuits `local` to "allowed", so nothing
 * was rejected and nothing was logged. The button did nothing, silently.
 *
 * The fix is a real state change in Main first (`auth.requestSignIn` — leave
 * `local`, drop the entry latch) and only THEN the event, which now has
 * something different to route on.
 *
 * ## Why the call sites keep their own hook instance
 *
 * Switching credential modes is an async IPC round trip that can be refused
 * (a keyring that has not answered yet). Both halves of that — a spinner while
 * it is in flight and a toast when it is refused — have to appear on the
 * control the user actually pressed, which is exactly what a hook gives each
 * one for free.
 */

import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import { useCallback, useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

export interface SignInRequest {
  /**
   * Reports its own failures (toast), so a caller never has to. Resolves `true`
   * once Main has moved and the routing event is out — the signal a caller
   * needs to decide whether to also close the surface it lives in.
   */
  requestSignIn: () => Promise<boolean>;
  /** True while the IPC round trip is in flight — drive the button's disabled/spinner state off this. */
  requesting: boolean;
}

export function useSignInRequest(): SignInRequest {
  const { t } = useI18n();
  const [requesting, setRequesting] = useState(false);

  const requestSignIn = useCallback(async (): Promise<boolean> => {
    // Double-click guard. A second call would be harmless in Main (both writes
    // are idempotent), but it would race this hook's own pending flag.
    if (requesting) return false;
    setRequesting(true);
    try {
      const result = await window.electronAPI.auth.requestSignIn();
      if (!result.ok) {
        toastManager.add({
          type: 'error',
          title: t('Could not open the sign-in screen'),
          description: t('Credentials are still unlocking. Try again in a moment.'),
        });
        return false;
      }
      // Main has changed its mind about where this run belongs; the event is
      // what tells Root to go re-ask.
      window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT));
      return true;
    } catch (error) {
      // An IPC that rejects outright (channel torn down, handler threw) must
      // still say so — silence here is the original defect wearing a different
      // hat.
      toastManager.add({
        type: 'error',
        title: t('Could not open the sign-in screen'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
      return false;
    } finally {
      setRequesting(false);
    }
  }, [requesting, t]);

  return { requestSignIn, requesting };
}

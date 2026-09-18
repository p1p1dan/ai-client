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
 * ## The confirmation in front of it
 *
 * That fix gave the app its first way to unmount `<App/>` while the user is
 * working, and unmounting kills every terminal in the tree — a shell gets
 * SIGKILL across its whole process group, a Pi TUI gets disposed. Losing a
 * running build to a mis-click is not acceptable, so the request now stops and
 * shows what it is about to cost (`stores/signInConfirm.ts`). Three rules:
 *
 *  1. Nothing to lose → no dialog. An empty confirmation is friction with no
 *     content, and it is the fastest way to teach someone to click through the
 *     one that does matter.
 *  2. `prompt: 'skip'` for a caller that ALREADY asked, listing the same
 *     losses. Logout is the only one — stacking a second dialog on top of its
 *     confirm would ask the same question twice.
 *  3. A declined prompt returns `false` WITHOUT a toast. The user just said no;
 *     narrating it back to them is noise. Only a prompt that could not be shown
 *     at all is reported, because that one is a wiring bug.
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
import { hasSignInLosses } from '@/components/auth/signInLossModel';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import {
  readSignInLosses,
  requestSignInConfirmation,
  type SignInPromptKind,
} from '@/stores/signInConfirm';

export interface SignInRequestOptions {
  /**
   * Which confirmation to show first. `'skip'` is for a caller that has already
   * shown the same losses in its own dialog.
   */
  prompt?: SignInPromptKind | 'skip';
}

export interface SignInRequest {
  /**
   * Reports its own failures (toast), so a caller never has to. Resolves `true`
   * once Main has moved and the routing event is out — the signal a caller
   * needs to decide whether to also close the surface it lives in.
   *
   * Resolves `false` when the user declined the confirmation, in which case
   * NOTHING has changed: no credential-mode write, no cleared entry latch, no
   * routing event.
   */
  requestSignIn: (options?: SignInRequestOptions) => Promise<boolean>;
  /** True while the IPC round trip is in flight — drive the button's disabled/spinner state off this. */
  requesting: boolean;
}

export function useSignInRequest(): SignInRequest {
  const { t } = useI18n();
  const [requesting, setRequesting] = useState(false);

  const requestSignIn = useCallback(
    async (options?: SignInRequestOptions): Promise<boolean> => {
      // Double-click guard. A second call would be harmless in Main (both writes
      // are idempotent), but it would race this hook's own pending flag.
      if (requesting) return false;

      const prompt = options?.prompt ?? 'confirm';
      if (prompt !== 'skip') {
        // Snapshot BEFORE anything is touched, so a cancel really is a no-op —
        // and so the numbers on screen cannot drift while they are being read.
        const losses = readSignInLosses();
        if (hasSignInLosses(losses)) {
          const outcome = await requestSignInConfirmation(prompt, losses);
          if (outcome === 'declined') return false;
          if (outcome === 'unavailable') {
            // No host mounted: the prompt could not be shown, so consent was
            // never given. Going ahead anyway would kill the user's terminals
            // with no warning at all — exactly what this guard exists for.
            toastManager.add({
              type: 'error',
              title: t('Could not open the sign-in screen'),
              description: t('The confirmation could not be shown. Try again in a moment.'),
            });
            return false;
          }
        }
      }

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
    },
    [requesting, t]
  );

  return { requestSignIn, requesting };
}

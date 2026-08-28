import type { AuthGateWelcomeEntry } from '@shared/authGate';
import { Loader2Icon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { AiClientMark } from './AiClientMark';

/**
 * A2 — the two-button first screen, shown on EVERY launch.
 *
 * ## It is the startup screen, not a first-run screen
 *
 * User ruling 2026-08-27:「就是启动首屏，每次都出现」. Signing in or choosing a
 * setup does not retire it — quitting and reopening puts the same two buttons
 * back. That is also why there is no separate "switch credential source"
 * control anywhere: relaunching IS the switch.
 *
 * ## The two buttons are two different promises, and the copy has to say so
 *
 * Sign in routes every session through our managed gateway; we supply the
 * credential and we own it working. "Use my own setup" injects NOTHING — the
 * bundled Claude Code and Codex authenticate from whatever is already on the
 * machine, and whether that works is the user's own business
 * ([D68](../../../../docs/plans/openchamber-chat-refactor-ledger.md):
 * 「能不能用、坏了怎么办全部归用户」).
 *
 * That asymmetry is the reason each button carries one line of static
 * description. D68 forbids reporting AVAILABILITY here — no "found your
 * subscription", no "no local config detected", no greying out — because
 * [E1's forensics](../../../../docs/plans/2026-08-27-e1-local-credentials/README.md)
 * showed a static probe is wrong in both directions. Saying what a button DOES
 * is a different thing from claiming it will work, and D68's wording was
 * narrowed the same day to keep it.
 *
 * ## Why the second button is not labelled "Bring your own key"
 *
 * That was the phrase the request arrived in, and it is narrower than the
 * route: E1 §L1 measured an ordinary Claude subscription login
 * (`~/.claude/.credentials.json`) authenticating on its own, no API key
 * anywhere. Labelling the button BYOK would tell every subscription user it is
 * not for them.
 *
 * ## Two states, one screen
 *
 * The second button never changes. The first depends on the ACCOUNT and on
 * nothing else: `Continue as <email>` when someone is signed in,
 * `Log in with work email` when nobody is. A person who signed in yesterday is
 * not asked to do it again — they just confirm which account they are going in
 * with.
 *
 * "work email" rather than a domain: two suffixes are accepted
 * (`@jcdz.cc` and `@wuhanjingce.com`, see `OnboardingView`), so naming one
 * would read as excluding the other, and adding a third later would mean
 * editing a button label.
 */

const PRODUCT_NAME = 'PILAB';

export interface WelcomeViewProps {
  entry: AuthGateWelcomeEntry;
  /** Open the sign-in sub-flow (email → code). */
  onSignIn: () => void;
  /** `continue` pressed: record `managed` and mount the app. */
  onContinue: () => void;
  /** Second button: record `local` and mount the app. */
  onUseOwnSetup: () => void;
}

export function WelcomeView({ entry, onSignIn, onContinue, onUseOwnSetup }: WelcomeViewProps) {
  const { t } = useI18n();
  const [pending, setPending] = useState<'primary' | 'local' | null>(null);

  const handlePrimary = useCallback(() => {
    if (entry.primary === 'sign-in') {
      onSignIn();
      return;
    }
    setPending('primary');
    onContinue();
  }, [entry.primary, onSignIn, onContinue]);

  const handleLocal = useCallback(() => {
    setPending('local');
    onUseOwnSetup();
  }, [onUseOwnSetup]);

  const primaryLabel =
    entry.primary === 'continue' && entry.email
      ? t('Continue as {{email}}').replace('{{email}}', entry.email)
      : t('Log in with work email');

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
      <AiClientMark />

      <div className="flex flex-col items-center gap-2">
        <h1 className="font-semibold text-2xl tracking-[0.2em] text-foreground">{PRODUCT_NAME}</h1>
        <p className="text-muted-foreground text-sm">
          {t('Just a really good one to code with ai.')}
        </p>
      </div>

      {entry.notice === 'expired' ? (
        <p className="text-sm text-warning">{t('Your session expired. Sign in again.')}</p>
      ) : null}

      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Button className="w-full" disabled={pending !== null} onClick={handlePrimary} size="lg">
            {pending === 'primary' ? <Loader2Icon className="animate-spin" /> : null}
            {primaryLabel}
          </Button>
          <p className="text-muted-foreground text-xs">
            {t('Runs on the managed gateway. Nothing is written to your machine.')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Button
            className="w-full"
            disabled={pending !== null}
            onClick={handleLocal}
            size="lg"
            variant="outline"
          >
            {pending === 'local' ? <Loader2Icon className="animate-spin" /> : null}
            {t('Use my own setup')}
          </Button>
          <p className="text-muted-foreground text-xs">
            {t('Runs on the Claude Code and Codex configuration already on this machine.')}
          </p>
        </div>
      </div>
    </div>
  );
}

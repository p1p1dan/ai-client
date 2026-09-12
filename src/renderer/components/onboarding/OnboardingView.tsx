import type { AuthGateOnboardingReason } from '@shared/authGate';
import type { Translate } from '@shared/i18n';
import type {
  OnboardingErrorCode,
  OnboardingRegisterClientResponse,
  OnboardingSendCodeResponse,
} from '@shared/types';
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, MailIcon, ServerIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * A2 — `cli-check` / `cli-install` retired.
 *
 * The old prerequisite flow probed several external CLIs before letting
 * anyone in. Pi is bundled, and git—the one real external dependency—now has
 * a non-blocking notice in the app itself
 * (`GitMissingNotice`). What is left here is the sign-in sub-flow that the
 * welcome screen's primary button opens.
 */
type Step = 'register-email' | 'register-code' | 'result';

const ALLOWED_EMAIL_SUFFIXES = ['@jcdz.cc', '@wuhanjingce.com'] as const;
const CODE_LENGTH = 6;

/**
 * Map machine-readable server errors to user-facing copy.
 *
 * Takes a translator rather than returning a key: three of the messages
 * interpolate a number or the allowed-suffix list, and those cannot be keys.
 * Same split as the tool verbs (batch 4) — the fixed ones are keys, the
 * parameterised ones are built here with `t` already in hand.
 */
function describeOnboardingError(
  t: Translate,
  error: OnboardingErrorCode | string | undefined,
  attemptsLeft?: number
): string {
  if (!error) return t('That did not work. Please try again.');
  switch (error) {
    case 'EMAIL_INVALID':
      return t('That email address is not valid.');
    case 'EMAIL_DOMAIN_NOT_ALLOWED':
      return t('Only {{suffixes}} addresses are accepted.', {
        suffixes: ALLOWED_EMAIL_SUFFIXES.join(' / '),
      });
    case 'INVALID_BODY':
      return t('The request was malformed. Please try again.');
    case 'RATE_LIMITED':
      return t('Too many attempts. Please try again later.');
    case 'CODE_INVALID':
      return attemptsLeft !== undefined
        ? t('Wrong code. {{count}} attempts left.', { count: attemptsLeft })
        : t('Wrong code.');
    case 'CODE_EXPIRED':
      return t('That code has expired. Send a new one.');
    case 'CODE_USED':
      return t('That code has already been used. Send a new one.');
    case 'CODE_LOCKED':
      return t('Too many wrong attempts. Send a new code.');
    case 'SMTP_FAILED':
      return t('The email could not be sent. Please try again later.');
    case 'CCH_FAILED':
    case 'CCH_UNREACHABLE':
    case 'KEY_NOT_READY':
      return t('The service is temporarily unavailable. Please try again later.');
    case 'INTERNAL_ERROR':
      return t('The service hit an internal error. Please try again later.');
    default:
      // A code this build does not know: shown verbatim rather than replaced
      // with a generic sentence, because the raw string is the only clue left.
      return error;
  }
}

function isValidEmailFormat(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes('@')) return false;
  return ALLOWED_EMAIL_SUFFIXES.some((suffix) => trimmed.endsWith(suffix));
}

export interface OnboardingViewProps {
  onComplete: () => void;
  className?: string;
  /** Override the initial step. Defaults to `register-email`, the only entry A2 leaves. */
  initialStep?: Step;
  /**
   * D47 S5: why the gate routed here (`deriveOnboardingEntry`, @shared/authGate).
   * `'expired'` swaps the register-email copy for a re-verification message
   * and hides the "返回" (back to CLI check) button — with an expired login
   * there is nothing to go back to, only forward through email verification.
   */
  reason?: AuthGateOnboardingReason;
  /** Prefill for the email step — `AuthState.lastEmail`, when known. */
  initialEmail?: string | null;
  /** A2 — leave the sign-in sub-flow and return to the welcome screen. Omit to hide the control. */
  onBack?: () => void;
}

export function OnboardingView({
  onComplete,
  className,
  initialStep,
  reason,
  initialEmail,
  onBack,
}: OnboardingViewProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(initialStep ?? 'register-email');

  const [serverUrl] = useState<string>(() => {
    const injected =
      typeof __ONBOARDING_SERVICE_URL__ === 'string' ? __ONBOARDING_SERVICE_URL__ : '';
    return injected || 'https://onboarding-jyw.pipidan.qzz.io';
  });

  // Step: register-email
  // D47 S5 mutation ⑥: `initialEmail` (AuthState.lastEmail) must survive into
  // the prefill — a returning user re-verifying an expired login should not
  // have to retype an address the app already knows.
  const [email, setEmail] = useState(initialEmail ?? '');
  const [sendingCode, setSendingCode] = useState(false);
  const [sendCodeError, setSendCodeError] = useState<string | null>(null);

  // Step: register-code
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resendCountdown, setResendCountdown] = useState(0);

  const [registerResult, setRegisterResult] = useState<OnboardingRegisterClientResponse | null>(
    null
  );

  // Tick down the resend cooldown each second while we're on the code step.
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown((n) => n - 1), 1_000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const handleSendCode = useCallback(
    async (opts?: { resend?: boolean }) => {
      setSendCodeError(null);
      setSendingCode(true);
      try {
        const response: OnboardingSendCodeResponse = await window.electronAPI.onboarding.sendCode({
          email: email.trim(),
        });

        if (!response.ok) {
          setSendCodeError(describeOnboardingError(t, response.error));
          if (response.data?.retryAfterSec) {
            setResendCountdown(response.data.retryAfterSec);
          }
          return;
        }

        setResendCountdown(response.data?.resendAfterSec ?? 30);
        if (!opts?.resend) {
          setCode('');
          setVerifyError(null);
          setStep('register-code');
        }
      } catch (err) {
        setSendCodeError(err instanceof Error ? err.message : t('Unknown error.'));
      } finally {
        setSendingCode(false);
      }
    },
    [email, t]
  );

  const handleVerify = useCallback(async () => {
    setVerifyError(null);
    setVerifying(true);
    try {
      const result: OnboardingRegisterClientResponse =
        await window.electronAPI.onboarding.verifyAndRegister({
          email: email.trim(),
          code: code.trim(),
        });
      setRegisterResult(result);
      if (result.ok) {
        setStep('result');
      } else {
        setVerifyError(describeOnboardingError(t, result.error, result.data?.attemptsLeft));
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : t('Unknown error.'));
    } finally {
      setVerifying(false);
    }
  }, [email, code, t]);

  const canSendCode = isValidEmailFormat(email) && !sendingCode;
  const canVerify = code.trim().length === CODE_LENGTH && !verifying;

  return (
    <div
      className={cn(
        'flex w-full max-w-md flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg',
        className
      )}
    >
      {step === 'register-email' && (
        <>
          <SectionHeader
            icon={<ServerIcon className="h-5 w-5 text-muted-foreground" />}
            title={t('Sign up')}
            description={
              reason === 'expired'
                ? t('Your sign-in has expired. Verify your email again.')
                : t('Enter your email to receive a verification code.')
            }
          />
          <SectionBody>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-server">{t('Server address')}</Label>
                <Input
                  id="onboarding-server"
                  value={serverUrl}
                  disabled
                  className="text-muted-foreground"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-email">{t('Email')}</Label>
                <Input
                  id="onboarding-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@jcdz.cc"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSendCode) {
                      void handleSendCode();
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('Only {{suffixes}} addresses are accepted.', {
                    suffixes: ALLOWED_EMAIL_SUFFIXES.join(' / '),
                  })}
                </p>
              </div>
              {sendCodeError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{sendCodeError}</span>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            {/* A2: "back" now means the welcome screen — the only thing behind
                this step. Absent when the caller gives it nowhere to go. */}
            {onBack && (
              <Button disabled={sendingCode} onClick={onBack} variant="outline">
                {t('Back')}
              </Button>
            )}
            <Button onClick={() => void handleSendCode()} disabled={!canSendCode}>
              {sendingCode && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
              {t('Send code')}
            </Button>
          </SectionFooter>
        </>
      )}

      {step === 'register-code' && (
        <>
          <SectionHeader
            icon={<MailIcon className="h-5 w-5 text-muted-foreground" />}
            title={t('Enter the code')}
            description={t('Sent to {{email}}. Check your inbox, including spam.', {
              email: email.trim(),
            })}
          />
          <SectionBody>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-code">{t('Verification code')}</Label>
                <Input
                  id="onboarding-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={CODE_LENGTH}
                  pattern="\d*"
                  placeholder={'_'.repeat(CODE_LENGTH)}
                  className="text-center text-lg tracking-[0.5em] font-mono"
                  value={code}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
                    setCode(digits);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canVerify) {
                      void handleVerify();
                    }
                  }}
                  autoFocus
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {t('{{count}} digits, valid for 15 minutes.', { count: CODE_LENGTH })}
                  </span>
                  {resendCountdown > 0 ? (
                    <span>{t('Resend in {{seconds}}s', { seconds: resendCountdown })}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSendCode({ resend: true })}
                      disabled={sendingCode}
                      className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {sendingCode ? t('Resending...') : t('Resend')}
                    </button>
                  )}
                </div>
              </div>

              {verifyError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{verifyError}</span>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            <Button
              variant="outline"
              onClick={() => {
                setVerifyError(null);
                setCode('');
                setStep('register-email');
              }}
              disabled={verifying}
            >
              {t('Use a different email')}
            </Button>
            <Button onClick={() => void handleVerify()} disabled={!canVerify}>
              {verifying && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
              {t('Verify and sign up')}
            </Button>
          </SectionFooter>
        </>
      )}

      {step === 'result' && registerResult?.ok && (
        <>
          <SectionHeader
            description={t('Pi models and credentials are active for this session.')}
            icon={<CheckCircle2Icon className="h-5 w-5 text-success" />}
            title={t('Signed in')}
          />
          <SectionBody>
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              {registerResult.data?.user && (
                <p>{t('Welcome, {{name}}.', { name: registerResult.data.user.name })}</p>
              )}
              {/* Pi and its managed runtime ship with the app, so successful
                  registration can enter the product directly. */}
              <p>
                {t('You can switch back to your own local configuration in Settings at any time.')}
              </p>
            </div>
          </SectionBody>
          <SectionFooter>
            <Button onClick={onComplete}>{t('Get started')}</Button>
          </SectionFooter>
        </>
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-2 p-6 pb-3">
      <h2 className="flex items-center gap-2 font-heading text-title font-semibold leading-none tracking-[-0.01em]">
        {icon}
        {title}
      </h2>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

function SectionBody({ children }: { children: React.ReactNode }) {
  return <div className="px-6 pt-1 pb-1">{children}</div>;
}

function SectionFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 px-6 pt-3 pb-6 sm:flex-row sm:justify-end">
      {children}
    </div>
  );
}

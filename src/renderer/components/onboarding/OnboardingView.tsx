import type { AuthGateOnboardingReason } from '@shared/authGate';
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
import { cn } from '@/lib/utils';

/**
 * A2 — `cli-check` / `cli-install` retired.
 *
 * Both existed to probe and install `git` / `node` / `claude` / `codex` before
 * letting anyone in. A3/D65 established that three of those four ship inside
 * this app (so the probe decided nothing) and moved the fourth — git, the one
 * real dependency — to a non-blocking notice in the app itself
 * (`GitMissingNotice`). What is left here is the sign-in sub-flow that the
 * welcome screen's primary button opens.
 */
type Step = 'register-email' | 'register-code' | 'result';

const ALLOWED_EMAIL_SUFFIXES = ['@jcdz.cc', '@wuhanjingce.com'] as const;
const CODE_LENGTH = 6;

// Map machine-readable server errors to user-facing Chinese strings.
function describeOnboardingError(
  error: OnboardingErrorCode | string | undefined,
  attemptsLeft?: number
): string {
  if (!error) return '操作失败,请重试。';
  switch (error) {
    case 'EMAIL_INVALID':
      return '邮箱格式不正确。';
    case 'EMAIL_DOMAIN_NOT_ALLOWED':
      return `仅接受 ${ALLOWED_EMAIL_SUFFIXES.join(' / ')} 后缀。`;
    case 'INVALID_BODY':
      return '请求格式错误,请重试。';
    case 'RATE_LIMITED':
      return '操作过于频繁,请稍后再试。';
    case 'CODE_INVALID':
      return attemptsLeft !== undefined
        ? `验证码错误,还可重试 ${attemptsLeft} 次。`
        : '验证码错误。';
    case 'CODE_EXPIRED':
      return '验证码已过期,请重新发送。';
    case 'CODE_USED':
      return '验证码已被使用,请重新发送。';
    case 'CODE_LOCKED':
      return '错误次数过多,请重新发送验证码。';
    case 'SMTP_FAILED':
      return '邮件发送失败,请稍后再试。';
    case 'CCH_FAILED':
    case 'CCH_UNREACHABLE':
    case 'KEY_NOT_READY':
      return '服务暂时不可用,请稍后再试。';
    case 'INTERNAL_ERROR':
      return '服务内部错误,请稍后再试。';
    default:
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
          setSendCodeError(describeOnboardingError(response.error));
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
        setSendCodeError(err instanceof Error ? err.message : '未知错误。');
      } finally {
        setSendingCode(false);
      }
    },
    [email]
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
        setVerifyError(describeOnboardingError(result.error, result.data?.attemptsLeft));
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : '未知错误。');
    } finally {
      setVerifying(false);
    }
  }, [email, code]);

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
            title="注册"
            description={
              reason === 'expired' ? '登录已失效，请重新验证邮箱。' : '输入邮箱以接收验证码。'
            }
          />
          <SectionBody>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-server">服务地址</Label>
                <Input
                  id="onboarding-server"
                  value={serverUrl}
                  disabled
                  className="text-muted-foreground"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-email">邮箱</Label>
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
                  仅接受 {ALLOWED_EMAIL_SUFFIXES.join(' / ')} 后缀。
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
                返回
              </Button>
            )}
            <Button onClick={() => void handleSendCode()} disabled={!canSendCode}>
              {sendingCode && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
              发送验证码
            </Button>
          </SectionFooter>
        </>
      )}

      {step === 'register-code' && (
        <>
          <SectionHeader
            icon={<MailIcon className="h-5 w-5 text-muted-foreground" />}
            title="输入验证码"
            description={`已发送至 ${email.trim()},请查收邮件(含垃圾箱)。`}
          />
          <SectionBody>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="onboarding-code">验证码</Label>
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
                  <span>{CODE_LENGTH} 位数字,15 分钟内有效。</span>
                  {resendCountdown > 0 ? (
                    <span>{resendCountdown}s 后可重发</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSendCode({ resend: true })}
                      disabled={sendingCode}
                      className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {sendingCode ? '重发中...' : '重新发送'}
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
              更换邮箱
            </Button>
            <Button onClick={() => void handleVerify()} disabled={!canVerify}>
              {verifying && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
              验证并注册
            </Button>
          </SectionFooter>
        </>
      )}

      {step === 'result' && registerResult?.ok && (
        <>
          <SectionHeader
            description="Claude Code 与 Codex 的凭据已在本次会话中生效。"
            icon={<CheckCircle2Icon className="h-5 w-5 text-success" />}
            title="登录完成"
          />
          <SectionBody>
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              {registerResult.data?.user && (
                <p>
                  欢迎,
                  <span className="font-medium text-foreground">
                    {registerResult.data.user.name}
                  </span>
                  。
                </p>
              )}
              {/* A2 retired the three-way `mode` fork here. `register-only` and
                  `vscode-extension` both described worlds where the app could
                  not run yet — CLI not installed, or the user meant to work in
                  VSCode instead — and neither exists now that Claude Code,
                  Codex and Node all ship inside this build. */}
              <p>随时可以在设置里切换回使用本机自己的配置。</p>
            </div>
          </SectionBody>
          <SectionFooter>
            <Button onClick={onComplete}>开始使用</Button>
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

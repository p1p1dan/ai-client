import type {
  InstallAgentId,
  InstallProgress,
  InstallStepId,
  OnboardingCliStatus,
  OnboardingErrorCode,
  OnboardingRegisterResponse,
  OnboardingSendCodeResponse,
  VsCodeExtensionInfo,
} from '@shared/types';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  MailIcon,
  RocketIcon,
  ServerIcon,
  TerminalIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type Step = 'welcome' | 'cli-install' | 'register-email' | 'register-code' | 'result';
const ALLOWED_EMAIL_SUFFIXES = ['@jcdz.cc', '@wuhanjingce.com'] as const;
const CODE_LENGTH = 6;

const INSTALL_STEP_LABELS: Record<InstallStepId, string> = {
  git: 'Git',
  node: 'Node.js',
  claude: 'Claude Code',
  codex: 'Codex',
};

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

function createFallbackCliStatus(): OnboardingCliStatus {
  return {
    gitInstalled: false,
    nodeInstalled: false,
    wingetAvailable: false,
    claudeInstalled: false,
    codexInstalled: false,
  };
}

function createInitialInstallProgress(): Record<InstallStepId, InstallProgress> {
  return {
    git: { step: 'git', status: 'pending' },
    node: { step: 'node', status: 'pending' },
    claude: { step: 'claude', status: 'pending' },
    codex: { step: 'codex', status: 'pending' },
  };
}

function areAllToolsInstalled(status: OnboardingCliStatus): boolean {
  return (
    status.gitInstalled && status.nodeInstalled && status.claudeInstalled && status.codexInstalled
  );
}

function getInstallTargets(status: OnboardingCliStatus | null): InstallAgentId[] {
  if (!status) {
    return ['claude', 'codex'];
  }

  const targets: InstallAgentId[] = [];
  if (!status.claudeInstalled) {
    targets.push('claude');
  }
  if (!status.codexInstalled) {
    targets.push('codex');
  }
  return targets;
}

export interface OnboardingViewProps {
  onComplete: () => void;
  className?: string;
  /**
   * User already has credentials persisted but the CLI is missing. The view
   * stays on the CLI install track and bypasses the registration step.
   */
  alreadyRegistered?: boolean;
  /**
   * Override the initial step. Useful when the caller already knows where the
   * user should land — e.g. cli-missing callers pass 'result' to jump straight
   * to the completion / enter-AiClient screen.
   */
  initialStep?: Step;
  /**
   * VSCode Claude extension detected on this machine. When set, the completion
   * screen adds a "you can return to VSCode" hint — the extension reads the
   * same ~/.claude credentials this flow writes.
   */
  vscodeExtension?: VsCodeExtensionInfo;
}

export function OnboardingView({
  onComplete,
  className,
  alreadyRegistered = false,
  initialStep,
  vscodeExtension,
}: OnboardingViewProps) {
  // Default entry point: unregistered users start at the welcome screen;
  // alreadyRegistered (cli-missing) callers pass initialStep='result' explicitly.
  const [step, setStep] = useState<Step>(initialStep ?? (alreadyRegistered ? 'result' : 'welcome'));
  const [cliStatus, setCliStatus] = useState<OnboardingCliStatus | null>(null);
  const [cliLoading, setCliLoading] = useState(false);

  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<InstallStepId, InstallProgress>>(
    () => createInitialInstallProgress()
  );

  const [serverUrl] = useState<string>(() => {
    const injected =
      typeof __ONBOARDING_SERVICE_URL__ === 'string' ? __ONBOARDING_SERVICE_URL__ : '';
    return injected || 'https://onboarding-jyw.pipidan.qzz.io';
  });

  // Step: register-email
  const [email, setEmail] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [sendCodeError, setSendCodeError] = useState<string | null>(null);

  // Step: register-code
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resendCountdown, setResendCountdown] = useState(0);

  const [registerResult, setRegisterResult] = useState<OnboardingRegisterResponse | null>(null);

  const detectCli = useCallback(
    async (options?: { autoAdvance?: boolean }) => {
      setCliLoading(true);
      try {
        const status = await window.electronAPI.onboarding.detectCli();
        setCliStatus(status);
        if (options?.autoAdvance && areAllToolsInstalled(status)) {
          if (alreadyRegistered) {
            onComplete();
          } else {
            setStep('register-email');
          }
        }
        return status;
      } catch {
        const fallbackStatus = createFallbackCliStatus();
        setCliStatus(fallbackStatus);
        return fallbackStatus;
      } finally {
        setCliLoading(false);
      }
    },
    [alreadyRegistered, onComplete]
  );

  useEffect(() => {
    return window.electronAPI.onboarding.onInstallProgress((progress) => {
      setInstallProgress((current) => ({
        ...current,
        [progress.step]: progress,
      }));
    });
  }, []);

  useEffect(() => {
    // Detect CLI in the background on the welcome / result screens so the
    // completion screen knows whether Claude is installed (drives the "进入
    // AiClient" vs "需要先安装" branch). Never auto-advances — registration is
    // the mandatory trunk the user walks manually.
    if (step === 'welcome' || step === 'result') {
      void detectCli();
    }
  }, [step, detectCli]);

  // Tick down the resend cooldown each second while we're on the code step.
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown((n) => n - 1), 1_000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const handleInstall = useCallback(async () => {
    setInstallError(null);
    setInstallProgress(createInitialInstallProgress());
    setInstalling(true);
    setStep('cli-install');

    try {
      const result = await window.electronAPI.onboarding.installAgents(
        getInstallTargets(cliStatus)
      );
      const refreshedStatus = await detectCli();

      if (result.cancelled) {
        // Installation is only reachable from the completion screen's "进入
        // AiClient" confirm, so a cancel returns there — not to a standalone
        // cli-check screen (which no longer exists as an entry point).
        setStep('result');
        return;
      }

      if (refreshedStatus.claudeInstalled) {
        // Registration (the mandatory trunk) is always done by the time install
        // runs, so a successful install means we can enter the app directly.
        onComplete();
        return;
      }

      setInstallError(result.errors[0] || '安装失败。');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : '安装失败。');
    } finally {
      setInstalling(false);
    }
  }, [cliStatus, detectCli, onComplete]);

  const handleCancelInstall = useCallback(async () => {
    if (!installing) {
      setStep('result');
      return;
    }

    try {
      await window.electronAPI.onboarding.cancelInstall();
    } catch {
      setInstallError('取消安装失败。');
      setInstalling(false);
    }
  }, [installing]);

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
      const result: OnboardingRegisterResponse =
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

  // "返回" from the email step goes back to the welcome screen — the
  // register-first trunk starts there.
  const handleBackToWelcome = () => {
    setSendCodeError(null);
    setVerifyError(null);
    setRegisterResult(null);
    setStep('welcome');
  };

  const handleQuitApp = () => {
    void window.electronAPI.app.quit();
  };

  // Completion-screen fork state: entering AiClient requires the CLI. When it's
  // missing we don't silently install — we show a confirm prompt first.
  const [showInstallConfirm, setShowInstallConfirm] = useState(false);
  const [enterChecking, setEnterChecking] = useState(false);

  const handleEnterAiClient = useCallback(async () => {
    // Re-detect at click time rather than trusting the background cliStatus,
    // which may still be null/stale if detection hasn't returned yet. This makes
    // a single click always act on the true CLI state (no swallowed clicks, no
    // false "needs install" when the CLI is actually present).
    if (enterChecking) return;
    setEnterChecking(true);
    try {
      const status = await detectCli();
      if (status.claudeInstalled) {
        onComplete();
      } else {
        // CLI missing: ask before installing rather than kicking off a 1-3 min
        // download unannounced.
        setShowInstallConfirm(true);
      }
    } finally {
      setEnterChecking(false);
    }
  }, [enterChecking, detectCli, onComplete]);

  return (
    <div
      className={cn(
        'flex w-full max-w-md flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg',
        className
      )}
    >
      {step === 'welcome' && (
        <>
          <SectionHeader
            icon={<RocketIcon className="h-5 w-5 text-muted-foreground" />}
            title="欢迎使用 AiClient"
            description="完成注册即可写入 Claude Code 与 Codex 的环境配置。注册后可选择进入 AiClient,或返回其他编辑器(如 VSCode)直接使用。"
          />
          <SectionBody>
            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              <div className="flex items-start gap-2">
                <ServerIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  <span className="font-medium text-foreground">注册并配置环境</span>
                  ——写入 CLI 凭据,所有用户必经。
                </span>
              </div>
              <div className="flex items-start gap-2">
                <RocketIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  <span className="font-medium text-foreground">按需进入 AiClient</span>
                  ——若要在本机使用,再安装 Claude Code CLI 即可。
                </span>
              </div>
            </div>
          </SectionBody>
          <SectionFooter>
            <Button className="btn-flow" onClick={() => setStep('register-email')}>
              开始注册
              <ChevronRightIcon className="ml-1 h-4 w-4" />
            </Button>
          </SectionFooter>
        </>
      )}

      {step === 'cli-install' && (
        <>
          <SectionHeader
            icon={<TerminalIcon className="h-5 w-5 text-muted-foreground" />}
            title="正在安装 CLI 工具"
            description="将先安装基础环境,随后安装缺失的 Agent CLI。"
          />
          <SectionBody>
            <div className="flex flex-col gap-3">
              {(['git', 'node', 'claude', 'codex'] as const).map((installStep) => (
                <InstallProgressRow
                  key={installStep}
                  name={INSTALL_STEP_LABELS[installStep]}
                  progress={installProgress[installStep]}
                />
              ))}

              {installError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{installError}</span>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            {installing ? (
              <Button variant="outline" onClick={handleCancelInstall}>
                取消
              </Button>
            ) : installError ? (
              <>
                <Button variant="outline" onClick={() => setStep('result')}>
                  返回
                </Button>
                <Button onClick={handleInstall}>重试</Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setStep('result')}>
                返回
              </Button>
            )}
          </SectionFooter>
        </>
      )}

      {step === 'register-email' && (
        <>
          <SectionHeader
            icon={<ServerIcon className="h-5 w-5 text-muted-foreground" />}
            title="注册"
            description="输入邮箱以接收验证码,注册后写入 Claude 与 Codex 的环境配置。"
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
            <Button variant="outline" onClick={handleBackToWelcome} disabled={sendingCode}>
              返回
            </Button>
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

      {step === 'result' && (registerResult?.ok || alreadyRegistered) && (
        <>
          <SectionHeader
            icon={<CheckCircle2Icon className="h-5 w-5 text-success" />}
            title="注册完成,环境已配置"
            description="Claude Code 与 Codex 的凭据已写入本地配置。你可以进入 AiClient 使用,或退出后在其他编辑器中直接使用。"
          />
          <SectionBody>
            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              {registerResult?.data?.user && (
                <p>
                  欢迎,
                  <span className="font-medium text-foreground">
                    {registerResult.data.user.name}
                  </span>
                  。
                </p>
              )}

              {/* Condition: VSCode extension detected → hint the user can return to it. */}
              {vscodeExtension && (
                <div className="rounded-lg border border-primary/28 bg-primary/6 px-3 py-2">
                  检测到 VSCode Claude 扩展,凭据已写入 ~/.claude/settings.json,可直接返回 VSCode
                  使用。
                </div>
              )}

              {/* Condition: CLI missing → entering AiClient will need an install. */}
              {!cliStatus?.claudeInstalled && !cliLoading && (
                <div className="flex items-center gap-2 rounded-lg border border-warning/28 bg-warning/6 px-3 py-2">
                  <AlertCircleIcon className="h-4 w-4 shrink-0 text-warning" />
                  <span>未检测到 Claude Code CLI,进入 AiClient 前需先安装。</span>
                </div>
              )}

              {installError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-destructive">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{installError}</span>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            {showInstallConfirm ? (
              <>
                <Button variant="outline" onClick={() => setShowInstallConfirm(false)}>
                  取消
                </Button>
                <Tooltip>
                  <TooltipTrigger render={<span />}>
                    <Button
                      onClick={() => {
                        setShowInstallConfirm(false);
                        void handleInstall();
                      }}
                    >
                      确认安装
                    </Button>
                  </TooltipTrigger>
                  <TooltipPopup side="top">需管理员权限,可能耗时 1-3 分钟</TooltipPopup>
                </Tooltip>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={handleQuitApp} disabled={enterChecking}>
                  退出
                </Button>
                <Button
                  className="btn-flow"
                  onClick={() => void handleEnterAiClient()}
                  disabled={enterChecking}
                >
                  {enterChecking && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
                  进入 AiClient
                  <ChevronRightIcon className="ml-1 h-4 w-4" />
                </Button>
              </>
            )}
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
      <h2 className="flex items-center gap-2 font-heading text-xl font-semibold leading-none">
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

function InstallProgressRow({ name, progress }: { name: string; progress: InstallProgress }) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <span className="text-sm font-medium">{name}</span>
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {progress.status === 'installing' ? (
          <Loader2Icon className="h-4 w-4 animate-spin text-primary" />
        ) : progress.status === 'done' ? (
          <CheckCircle2Icon className="h-4 w-4 text-success" />
        ) : progress.status === 'error' ? (
          <AlertCircleIcon className="h-4 w-4 text-destructive" />
        ) : progress.status === 'skipped' ? (
          <CheckCircle2Icon className="h-4 w-4 text-muted-foreground" />
        ) : (
          <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
        )}
        <span>{getProgressLabel(progress)}</span>
      </div>
    </div>
  );
}

function getProgressLabel(progress: InstallProgress): string {
  if (progress.message) {
    return progress.message;
  }

  switch (progress.status) {
    case 'installing':
      return '安装中…';
    case 'done':
      return '已完成';
    case 'skipped':
      return '已跳过';
    case 'error':
      return '失败';
    default:
      return '等待中';
  }
}

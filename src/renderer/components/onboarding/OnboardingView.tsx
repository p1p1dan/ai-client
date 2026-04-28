import type {
  InstallAgentId,
  InstallProgress,
  InstallStepId,
  OnboardingCliStatus,
  OnboardingErrorCode,
  OnboardingRegisterResponse,
  OnboardingSendCodeResponse,
} from '@shared/types';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  MailIcon,
  ServerIcon,
  TerminalIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Step = 'cli-check' | 'cli-install' | 'register-email' | 'register-code' | 'result';
type OnboardingMode = 'standard' | 'register-only';

const INSTALL_GUIDE_URL = 'https://api-doc.pipidan.xyz/installation.html';
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
}

export function OnboardingView({
  onComplete,
  className,
  alreadyRegistered = false,
}: OnboardingViewProps) {
  const [step, setStep] = useState<Step>('cli-check');
  const [mode, setMode] = useState<OnboardingMode>('standard');
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
    if (step === 'cli-check') {
      void detectCli({ autoAdvance: true });
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
        setStep('cli-check');
        return;
      }

      if (refreshedStatus.claudeInstalled) {
        if (alreadyRegistered) {
          onComplete();
        } else {
          setStep('register-email');
        }
        return;
      }

      setInstallError(result.errors[0] || '安装失败。');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : '安装失败。');
    } finally {
      setInstalling(false);
    }
  }, [cliStatus, detectCli, alreadyRegistered, onComplete]);

  const handleCancelInstall = useCallback(async () => {
    if (!installing) {
      setStep('cli-check');
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
  const hasMissingTools = cliStatus
    ? !cliStatus.gitInstalled ||
      !cliStatus.nodeInstalled ||
      !cliStatus.claudeInstalled ||
      !cliStatus.codexInstalled
    : false;

  const handleOpenInstallGuide = () => {
    void window.electronAPI.shell.openExternal(INSTALL_GUIDE_URL);
  };

  const handleRegisterOnly = () => {
    setMode('register-only');
    setSendCodeError(null);
    setVerifyError(null);
    setRegisterResult(null);
    setStep('register-email');
  };

  const handleReturnToInstall = () => {
    setMode('standard');
    setSendCodeError(null);
    setVerifyError(null);
    setRegisterResult(null);
    setStep('cli-check');
  };

  const handleQuitApp = () => {
    void window.electronAPI.app.quit();
  };

  return (
    <div
      className={cn(
        'flex w-full max-w-md flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg',
        className
      )}
    >
      {step === 'cli-check' && (
        <>
          <SectionHeader
            icon={<TerminalIcon className="h-5 w-5 text-muted-foreground" />}
            title="CLI 环境检查"
            description="初始化将先校验基础环境,再安装必需的 Claude Code(Codex 为可选)。"
          />
          <SectionBody>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  基础环境
                </p>
                <CliRow
                  name="Git"
                  installed={cliStatus?.gitInstalled}
                  version={cliStatus?.gitVersion}
                  loading={cliLoading}
                />
                <CliRow
                  name="Node.js"
                  installed={cliStatus?.nodeInstalled}
                  version={cliStatus?.nodeVersion}
                  loading={cliLoading}
                  missingLabel={
                    cliStatus?.nodeVersion ? `${cliStatus.nodeVersion}(需 ≥ 18)` : undefined
                  }
                />
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  CLI 工具
                </p>
                <CliRow
                  name="Claude Code"
                  installed={cliStatus?.claudeInstalled}
                  version={cliStatus?.claudeVersion}
                  loading={cliLoading}
                />
                <CliRow
                  name="Codex"
                  installed={cliStatus?.codexInstalled}
                  version={cliStatus?.codexVersion}
                  loading={cliLoading}
                />
              </div>

              {cliStatus && !cliStatus.wingetAvailable && hasMissingTools && (
                <div className="rounded-lg border border-warning/28 bg-warning/6 px-3 py-2 text-sm text-muted-foreground">
                  未检测到 `winget`,安装程序将尽量通过直接下载方式完成安装。
                </div>
              )}

              {cliStatus && !cliStatus.claudeInstalled && (
                <div className="rounded-lg border border-warning/28 bg-warning/6 px-3 py-2 text-sm text-muted-foreground">
                  继续注册前需先安装 Claude Code。
                </div>
              )}

              {cliStatus && hasMissingTools && (
                <div className="flex flex-col gap-2 rounded-lg border border-warning/28 bg-warning/6 px-3 py-2 text-sm text-muted-foreground">
                  <span>
                    自动安装失败?可参考安装指南手动配置(
                    <button
                      type="button"
                      onClick={handleOpenInstallGuide}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {INSTALL_GUIDE_URL}
                    </button>
                    ){alreadyRegistered ? '。' : ',或先仅完成注册和环境配置。'}
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={handleOpenInstallGuide}>
                      打开安装指南
                    </Button>
                    {!alreadyRegistered && (
                      <Button size="sm" variant="outline" onClick={handleRegisterOnly}>
                        仅完成注册和环境配置
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            {hasMissingTools && (
              <Button variant="outline" onClick={handleInstall} disabled={cliLoading}>
                一键安装
              </Button>
            )}
            <Button
              onClick={() => {
                if (alreadyRegistered) {
                  onComplete();
                } else {
                  setStep('register-email');
                }
              }}
              disabled={cliLoading || !cliStatus?.claudeInstalled}
            >
              {alreadyRegistered ? '完成' : '继续'}
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
                <Button variant="outline" onClick={() => setStep('cli-check')}>
                  返回
                </Button>
                <Button onClick={handleInstall}>重试</Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setStep('cli-check')}>
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
            description={
              mode === 'register-only'
                ? '当前仅写入本地配置与环境变量,CLI 工具可稍后安装。'
                : '输入邮箱以接收验证码。'
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
              {mode === 'register-only' && (
                <div className="rounded-lg border border-warning/28 bg-warning/6 px-3 py-2 text-sm text-muted-foreground">
                  此步骤仅写入本地配置与环境变量,CLI 工具可稍后安装。
                </div>
              )}
              {sendCodeError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{sendCodeError}</span>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            <Button variant="outline" onClick={handleReturnToInstall} disabled={sendingCode}>
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

      {step === 'result' && registerResult?.ok && (
        <>
          <SectionHeader
            icon={<CheckCircle2Icon className="h-5 w-5 text-success" />}
            title={mode === 'register-only' ? '注册信息已保存' : '初始化完成'}
            description={
              mode === 'register-only'
                ? '本地配置与环境变量已写入,CLI 工具仍需安装后方可使用。'
                : '环境配置已全部完成。'
            }
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
              {mode === 'register-only' ? (
                <p>凭据已写入本地配置,Claude Code 与 Codex 安装完成后即可使用。</p>
              ) : (
                <p>Claude Code 与 Codex 的凭据已在本次会话中生效。</p>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            {mode === 'register-only' ? (
              <>
                <Button variant="outline" onClick={handleQuitApp}>
                  退出应用
                </Button>
                <Button onClick={handleReturnToInstall}>返回安装</Button>
              </>
            ) : (
              <Button onClick={onComplete}>开始使用</Button>
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

function CliRow({
  name,
  installed,
  version,
  loading,
  missingLabel,
}: {
  name: string;
  installed?: boolean;
  version?: string;
  loading: boolean;
  missingLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <span className="text-sm font-medium">{name}</span>
      <div className="flex items-center gap-1.5 text-sm">
        {loading ? (
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : installed ? (
          <>
            <CheckCircle2Icon className="h-4 w-4 text-success" />
            <span className="text-muted-foreground">{version || '已安装'}</span>
          </>
        ) : (
          <>
            <AlertCircleIcon className="h-4 w-4 text-warning" />
            <span className="text-muted-foreground">{missingLabel || '未检测到'}</span>
          </>
        )}
      </div>
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

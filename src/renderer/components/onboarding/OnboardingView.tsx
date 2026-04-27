import type {
  InstallAgentId,
  InstallProgress,
  InstallStepId,
  OnboardingCliStatus,
  OnboardingRegisterResponse,
} from '@shared/types';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
  ServerIcon,
  TerminalIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Step = 'cli-check' | 'cli-install' | 'register' | 'result';
type OnboardingMode = 'standard' | 'register-only';

const INSTALL_GUIDE_URL = 'https://api-doc.pipidan.xyz/installation.html';

const INSTALL_STEP_LABELS: Record<InstallStepId, string> = {
  git: 'Git',
  node: 'Node.js',
  claude: 'Claude Code',
  codex: 'Codex',
};

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

/**
 * Onboarding content without Dialog wrapper. Used by OnboardingShell
 * (pre-app initialization gate) so the window title bar remains interactive.
 */
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
  const [email, setEmail] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
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
            setStep('register');
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
          setStep('register');
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

  const handleRegister = async () => {
    setRegisterError(null);
    setRegistering(true);
    try {
      const result = await window.electronAPI.onboarding.register({
        email: email.trim(),
        serverUrl: serverUrl.trim(),
        onboardingSecret: __ONBOARDING_SECRET__,
      });
      setRegisterResult(result);
      if (result.ok) {
        setStep('result');
      } else {
        setRegisterError(result.error || '注册失败。');
      }
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : '未知错误。');
    } finally {
      setRegistering(false);
    }
  };

  const canRegister = email.trim().length > 0 && !registering;
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
    setRegisterError(null);
    setRegisterResult(null);
    setStep('register');
  };

  const handleReturnToInstall = () => {
    setMode('standard');
    setRegisterError(null);
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
            description="初始化将先校验基础环境，再安装必需的 Claude Code（Codex 为可选）。"
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
                    cliStatus?.nodeVersion ? `${cliStatus.nodeVersion}（需 ≥ 18）` : undefined
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
                  未检测到 `winget`，安装程序将尽量通过直接下载方式完成安装。
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
                    自动安装失败？可参考安装指南手动配置（
                    <button
                      type="button"
                      onClick={handleOpenInstallGuide}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {INSTALL_GUIDE_URL}
                    </button>
                    ）{alreadyRegistered ? '。' : '，或先仅完成注册和环境配置。'}
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
                  setStep('register');
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
            description="将先安装基础环境，随后安装缺失的 Agent CLI。"
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

      {step === 'register' && (
        <>
          <SectionHeader
            icon={<ServerIcon className="h-5 w-5 text-muted-foreground" />}
            title="注册"
            description={
              mode === 'register-only'
                ? '当前仅写入本地配置与环境变量，CLI 工具可稍后安装。'
                : '连接至 JYW Hub 服务以完成初始化。'
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
                  placeholder="you@jcdz.cc"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">仅接受 @jcdz.cc 后缀的邮箱。</p>
              </div>
              {mode === 'register-only' && (
                <div className="rounded-lg border border-warning/28 bg-warning/6 px-3 py-2 text-sm text-muted-foreground">
                  此步骤仅写入本地配置与环境变量，CLI 工具可稍后安装。
                </div>
              )}
              {registerError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{registerError}</span>
                </div>
              )}
            </div>
          </SectionBody>
          <SectionFooter>
            <Button variant="outline" onClick={handleReturnToInstall} disabled={registering}>
              返回
            </Button>
            <Button onClick={handleRegister} disabled={!canRegister}>
              {registering && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
              注册
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
                ? '本地配置与环境变量已写入，CLI 工具仍需安装后方可使用。'
                : '环境配置已全部完成。'
            }
          />
          <SectionBody>
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              {registerResult.data?.user && (
                <p>
                  欢迎，
                  <span className="font-medium text-foreground">
                    {registerResult.data.user.name}
                  </span>
                  。
                </p>
              )}
              {mode === 'register-only' ? (
                <p>凭据已写入本地配置，Claude Code 与 Codex 安装完成后即可使用。</p>
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

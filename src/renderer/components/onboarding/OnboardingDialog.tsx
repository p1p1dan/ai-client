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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Step = 'cli-check' | 'cli-install' | 'register' | 'result';

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

interface OnboardingDialogProps {
  open: boolean;
  onComplete: () => void;
}

export function OnboardingDialog({ open, onComplete }: OnboardingDialogProps) {
  const [step, setStep] = useState<Step>('cli-check');
  const [cliStatus, setCliStatus] = useState<OnboardingCliStatus | null>(null);
  const [cliLoading, setCliLoading] = useState(false);

  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<InstallStepId, InstallProgress>>(
    () => createInitialInstallProgress()
  );

  const [serverUrl] = useState('https://cch-jyw.pipidan.qzz.io');
  const [email, setEmail] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerResult, setRegisterResult] = useState<OnboardingRegisterResponse | null>(null);

  const wasOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || wasOpen) {
      return;
    }

    setStep('cli-check');
    setCliStatus(null);
    setCliLoading(false);
    setInstallError(null);
    setInstallProgress(createInitialInstallProgress());
    setInstalling(false);
    setRegisterError(null);
    setRegisterResult(null);
    setRegistering(false);
    setEmail('');
  }, [open]);

  const detectCli = useCallback(async (options?: { autoAdvance?: boolean }) => {
    setCliLoading(true);
    try {
      const status = await window.electronAPI.onboarding.detectCli();
      setCliStatus(status);
      if (options?.autoAdvance && areAllToolsInstalled(status)) {
        setStep('register');
      }
      return status;
    } catch {
      const fallbackStatus = createFallbackCliStatus();
      setCliStatus(fallbackStatus);
      return fallbackStatus;
    } finally {
      setCliLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    return window.electronAPI.onboarding.onInstallProgress((progress) => {
      setInstallProgress((current) => ({
        ...current,
        [progress.step]: progress,
      }));
    });
  }, [open]);

  useEffect(() => {
    if (open && step === 'cli-check') {
      void detectCli({ autoAdvance: true });
    }
  }, [open, step, detectCli]);

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
        setStep('register');
        return;
      }

      setInstallError(result.errors[0] || 'Installation failed.');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Installation failed.');
    } finally {
      setInstalling(false);
    }
  }, [cliStatus, detectCli]);

  const handleCancelInstall = useCallback(async () => {
    if (!installing) {
      setStep('cli-check');
      return;
    }

    try {
      await window.electronAPI.onboarding.cancelInstall();
    } catch {
      setInstallError('Failed to cancel installation.');
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
        setRegisterError(result.error || 'Registration failed');
      }
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : 'Unknown error');
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

  return (
    <Dialog open={open}>
      <DialogPopup showCloseButton={false} className="max-w-md">
        {step === 'cli-check' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TerminalIcon className="h-5 w-5 text-muted-foreground" />
                CLI Environment Check
              </DialogTitle>
              <DialogDescription>
                Checking required prerequisites and CLI tools before setup.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Prerequisites
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
                      cliStatus?.nodeVersion
                        ? `${cliStatus.nodeVersion} (requires >= 18)`
                        : undefined
                    }
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    CLI Tools
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
                    `winget` is unavailable. Installer will fall back to direct downloads where
                    possible.
                  </div>
                )}

                {cliStatus && !cliStatus.claudeInstalled && (
                  <div className="rounded-lg border border-warning/28 bg-warning/6 px-3 py-2 text-sm text-muted-foreground">
                    Claude Code is required before continuing to registration.
                  </div>
                )}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              {hasMissingTools && (
                <Button variant="outline" onClick={handleInstall} disabled={cliLoading}>
                  Install Missing Tools
                </Button>
              )}
              <Button
                onClick={() => setStep('register')}
                disabled={cliLoading || !cliStatus?.claudeInstalled}
              >
                Continue
                <ChevronRightIcon className="ml-1 h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'cli-install' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TerminalIcon className="h-5 w-5 text-muted-foreground" />
                Installing CLI Tools
              </DialogTitle>
              <DialogDescription>
                Install prerequisites first, then install missing agent CLIs.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-3">
                {(['git', 'node', 'claude', 'codex'] as const).map((installStep) => (
                  <InstallProgressRow
                    key={installStep}
                    name={INSTALL_STEP_LABELS[installStep]}
                    progress={installProgress[installStep]}
                  />
                ))}

                {installError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive-foreground">
                    <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{installError}</span>
                  </div>
                )}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              {installing ? (
                <Button variant="outline" onClick={handleCancelInstall}>
                  Cancel
                </Button>
              ) : installError ? (
                <>
                  <Button variant="outline" onClick={() => setStep('cli-check')}>
                    Back
                  </Button>
                  <Button onClick={handleInstall}>Retry</Button>
                </>
              ) : (
                <Button variant="outline" onClick={() => setStep('cli-check')}>
                  Back
                </Button>
              )}
            </DialogFooter>
          </>
        )}

        {step === 'register' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ServerIcon className="h-5 w-5 text-muted-foreground" />
                Register
              </DialogTitle>
              <DialogDescription>
                Connect to the JYW Hub server to complete setup.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboarding-server">Server URL</Label>
                  <Input
                    id="onboarding-server"
                    value={serverUrl}
                    disabled
                    className="text-muted-foreground"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboarding-email">Email</Label>
                  <Input
                    id="onboarding-email"
                    type="email"
                    placeholder="you@jcdz.cc"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Only @jcdz.cc emails are accepted.
                  </p>
                </div>
                {registerError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm text-destructive-foreground">
                    <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{registerError}</span>
                  </div>
                )}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => setStep('cli-check')} disabled={registering}>
                Back
              </Button>
              <Button onClick={handleRegister} disabled={!canRegister}>
                {registering && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />}
                Register
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'result' && registerResult?.ok && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2Icon className="h-5 w-5 text-success" />
                Setup Complete
              </DialogTitle>
              <DialogDescription>
                Your environment has been configured successfully.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                {registerResult.data?.user && (
                  <p>
                    Welcome,{' '}
                    <span className="font-medium text-foreground">
                      {registerResult.data.user.name}
                    </span>
                    .
                  </p>
                )}
                <p>Claude Code and Codex credentials are now available for this app session.</p>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button onClick={onComplete}>Get Started</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
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
            <span className="text-muted-foreground">{version || 'installed'}</span>
          </>
        ) : (
          <>
            <AlertCircleIcon className="h-4 w-4 text-warning" />
            <span className="text-muted-foreground">{missingLabel || 'not found'}</span>
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
      return 'Installing...';
    case 'done':
      return 'Done';
    case 'skipped':
      return 'Skipped';
    case 'error':
      return 'Failed';
    default:
      return 'Pending';
  }
}

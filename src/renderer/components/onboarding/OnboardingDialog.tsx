import type {
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

type Step = 'cli-check' | 'register' | 'result';

interface OnboardingDialogProps {
  open: boolean;
  onComplete: () => void;
}

export function OnboardingDialog({ open, onComplete }: OnboardingDialogProps) {
  const [step, setStep] = useState<Step>('cli-check');
  const [cliStatus, setCliStatus] = useState<OnboardingCliStatus | null>(null);
  const [cliLoading, setCliLoading] = useState(false);

  const [serverUrl, setServerUrl] = useState('');
  const [onboardingSecret, setOnboardingSecret] = useState('');
  const [email, setEmail] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerResult, setRegisterResult] =
    useState<OnboardingRegisterResponse | null>(null);

  const detectCli = useCallback(async () => {
    setCliLoading(true);
    try {
      const status = await window.electronAPI.onboarding.detectCli();
      setCliStatus(status);
    } catch {
      setCliStatus({
        claudeInstalled: false,
        codexInstalled: false,
      });
    } finally {
      setCliLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && step === 'cli-check') {
      detectCli();
    }
  }, [open, step, detectCli]);

  const handleRegister = async () => {
    setRegisterError(null);
    setRegistering(true);
    try {
      const result = await window.electronAPI.onboarding.register({
        email: email.trim(),
        serverUrl: serverUrl.trim(),
        onboardingSecret: onboardingSecret.trim(),
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

  const canRegister =
    email.trim().length > 0 &&
    serverUrl.trim().length > 0 &&
    onboardingSecret.trim().length > 0 &&
    !registering;

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
                Checking for required CLI tools before setup.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-3">
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
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                onClick={() => setStep('register')}
                disabled={cliLoading}
              >
                Continue
                <ChevronRightIcon className="ml-1 h-4 w-4" />
              </Button>
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
                    placeholder="https://hub.example.com"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboarding-secret">Onboarding Secret</Label>
                  <Input
                    id="onboarding-secret"
                    type="password"
                    placeholder="Provided by your admin"
                    value={onboardingSecret}
                    onChange={(e) => setOnboardingSecret(e.target.value)}
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
              <Button
                variant="outline"
                onClick={() => setStep('cli-check')}
                disabled={registering}
              >
                Back
              </Button>
              <Button
                onClick={handleRegister}
                disabled={!canRegister}
              >
                {registering && (
                  <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />
                )}
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
                    Welcome, <span className="font-medium text-foreground">{registerResult.data.user.name}</span>.
                  </p>
                )}
                <p>Claude Code and Codex CLI configs have been applied.</p>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button onClick={onComplete}>
                Get Started
              </Button>
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
}: {
  name: string;
  installed?: boolean;
  version?: string;
  loading: boolean;
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
            <span className="text-muted-foreground">not found</span>
          </>
        )}
      </div>
    </div>
  );
}

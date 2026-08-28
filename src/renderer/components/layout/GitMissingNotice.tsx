import { GitBranch, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

/**
 * A3 (D65) — the new home of the git check.
 *
 * ## Why it moved, and why it is a notice rather than a gate
 *
 * Git used to be checked inside onboarding's `cli-check` step, next to probes
 * for `claude` and `codex`. Those two were retired because both ship inside
 * this app, so asking the machine about them decided nothing. Git is the
 * opposite case: this product is a worktree manager, so git is a REAL
 * dependency and the check has to survive — it just cannot live in a step that
 * is itself being deleted (A2 replaces the four-step onboarding with a
 * two-button first screen).
 *
 * It is deliberately NOT a blocker. The app has plenty of surface that works
 * without git (settings, chat against an existing checkout), and a modal on
 * launch would stop a user who may only want one of those. D65's ruling is
 * "keep the check, and on non-Windows just say something" — this is that
 * sentence as a component.
 *
 * ## The platform split is a capability difference, not a preference
 *
 * `AgentInstaller.installGit` is guarded by `ensureWindowsOnly`: on macOS and
 * Linux we can detect a missing git but cannot install one. Rather than offer a
 * button that would throw, those platforms get the download link — which was
 * the concrete gap D65 asked to close, because until now they got detection and
 * then silence.
 *
 * ## Dismissal is per-run on purpose
 *
 * Dismissing is not persisted. A user who installs git mid-session should stop
 * seeing this on the next launch without us having to invalidate a stored flag,
 * and a user who ignored it once should still be told next time — the
 * dependency did not stop being real because they closed a card.
 */
export function GitMissingNotice() {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const canInstall = window.electronAPI.env.platform === 'win32';

  const check = useCallback(async () => {
    try {
      const status = await window.electronAPI.onboarding.checkPrerequisites();
      setMissing(!status.gitInstalled);
    } catch {
      // A detection failure is not evidence that git is missing. Staying quiet
      // is the honest reading — telling a user with a working git to install
      // git is worse than saying nothing.
      setMissing(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await window.electronAPI.onboarding.installGit();
      if (result.ok) {
        setMissing(false);
      } else {
        setInstallError(result.error ?? null);
      }
    } finally {
      setInstalling(false);
    }
  }, []);

  if (!missing || dismissed) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <Alert className="pointer-events-auto max-w-lg shadow-lg" variant="warning">
        <GitBranch />
        <AlertTitle>{t('Git was not found on this computer')}</AlertTitle>
        <AlertDescription>
          {t('Worktrees, branches and source control need Git. Everything else still works.')}
          {installError ? <div className="mt-1 text-destructive">{installError}</div> : null}
        </AlertDescription>
        <div className="flex shrink-0 items-center gap-1" data-slot="alert-action">
          {canInstall ? (
            <Button disabled={installing} onClick={handleInstall} size="sm">
              {installing ? <Loader2 className="animate-spin" /> : null}
              {t('Install Git')}
            </Button>
          ) : (
            <Button
              onClick={() => window.electronAPI.shell.openExternal(GIT_DOWNLOAD_URL)}
              size="sm"
              variant="outline"
            >
              {t('Get Git')}
            </Button>
          )}
          <Button
            aria-label={t('Dismiss')}
            className="h-6 w-6"
            onClick={() => setDismissed(true)}
            size="icon"
            variant="ghost"
          >
            <X />
          </Button>
        </div>
      </Alert>
    </div>
  );
}

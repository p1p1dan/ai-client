import type { PiModelManagementSettings } from '@shared/piModelConfig';
import { LogIn, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useSignInRequest } from '@/hooks/useSignInRequest';
import { useI18n } from '@/i18n';
import { PI_MODEL_SYNC_DETAIL_LABEL, piModelSyncNoticeView } from './piModelSyncNoticeModel';
import { refreshPiModelCatalog } from './usePiModelCatalog';

/**
 * The recovery card for "you signed in, and your company's models did not
 * arrive".
 *
 * Why it lives above the composer, next to `ModelMissingNotice`, and not in
 * Settings: the failure happens during login, and the screen the user is
 * looking at a second later is this one. A notice buried in Settings · Pi
 * would only be found by somebody who already suspected the model catalog —
 * which is exactly the deduction a first-time tester cannot make.
 *
 * Why it is a standing card and not a toast: the sync fails once, at a moment
 * the user is not looking at the model menu. A toast shown then is gone by the
 * time they notice the menu is empty, and there is no way to get it back. The
 * card stays until a sync succeeds, and disappears by itself when one does.
 *
 * Copy and the choice of button come from `piModelSyncNoticeModel.ts`, which is
 * pure and tested; everything here is wiring.
 */
export function PiModelSyncNotice({ className }: { className?: string }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<PiModelManagementSettings | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { requestSignIn, requesting } = useSignInRequest();

  const read = useCallback(async () => {
    try {
      setSnapshot(await window.electronAPI.piModels.getStatus());
    } catch {
      // A status read that could not complete says nothing about the sync.
      // Keep whatever is on screen rather than inventing a second failure.
    }
  }, []);

  useEffect(() => {
    void read();
    // Signing in runs a fresh sync in Main (`ipc/onboarding.ts`'s `onSuccess`,
    // awaited before the renderer is answered), and the window is NOT
    // remounted when it does — so a mount-time read alone would miss every
    // sign-in that happens while the app is already open. The auth broadcast
    // is the one signal that the vault, and therefore the sync, has moved.
    return window.electronAPI.auth.onStateChanged(() => void read());
  }, [read]);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      // `piModels.sync` is the manual channel and ALWAYS forces — see
      // `ipc/piModels.ts`, which passes `{ force: true }` to
      // `syncManagedPiModels`. That matters here: without it the ten-minute
      // freshness window could swallow the retry and answer "fine" without
      // going near the network.
      const result = await window.electronAPI.piModels.sync();
      if (result.ok) {
        // Main invalidated its workers; this cache is the renderer's own and
        // nothing else clears it, so the menu would otherwise still be empty
        // after a retry that worked.
        await refreshPiModelCatalog();
      } else {
        // The card alone cannot report this: a second failure of the same kind
        // renders identically to the first, and a button whose only effect is
        // to leave the screen unchanged reads as broken.
        toastManager.add({
          type: 'error',
          title: t('Still could not load your company models'),
          description: t('Nothing changed. The reason below is the latest one.'),
        });
      }
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('Still could not load your company models'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
    } finally {
      setRetrying(false);
      await read();
    }
  }, [read, retrying, t]);

  const view = piModelSyncNoticeView({
    managed: snapshot?.managed ?? false,
    failure: snapshot?.lastFailure ?? null,
  });
  if (!view) return null;
  const detail = snapshot?.lastFailure?.error?.trim();

  return (
    <Alert variant="error" className={className}>
      <AlertTitle>{t(view.title)}</AlertTitle>
      <AlertDescription>
        <p>{t(view.message)}</p>
        <p>{t(view.hint)}</p>
        {detail && (
          <p className="max-h-20 select-text overflow-auto break-all whitespace-pre-wrap font-mono text-code">
            {/* Labelled, and below the explanation the user actually needs.
                The raw text is the engine's English diagnostic — evidence to
                forward, never the product's account of what went wrong. */}
            {t(PI_MODEL_SYNC_DETAIL_LABEL)} {detail}
          </p>
        )}
      </AlertDescription>
      <AlertAction>
        {view.action === 'retry' ? (
          <Button
            size="xs"
            variant="outline"
            className="h-6"
            disabled={retrying}
            onClick={() => void retry()}
          >
            <RefreshCw className={retrying ? 'animate-spin' : undefined} />
            {retrying ? t('Retrying') : t('Retry')}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            className="h-6"
            disabled={requesting}
            onClick={() => void requestSignIn()}
          >
            <LogIn />
            {t('Sign in again')}
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
}

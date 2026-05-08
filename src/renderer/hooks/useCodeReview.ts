import { useCallback } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import {
  CodeReviewBusyError,
  startCodeReview,
  stopCodeReview,
  useCodeReviewContinueStore,
} from '@/stores/codeReviewContinue';
import { useSettingsStore } from '@/stores/settings';

interface UseCodeReviewOptions {
  repoPath: string | undefined;
}

interface UseCodeReviewReturn {
  content: string;
  status: 'idle' | 'initializing' | 'streaming' | 'complete' | 'error';
  error: string | null;
  startReview: () => Promise<void>;
  stopReview: () => void;
  reset: () => void;
}

export function useCodeReview({ repoPath }: UseCodeReviewOptions): UseCodeReviewReturn {
  const { t } = useI18n();
  const codeReviewSettings = useSettingsStore((s) => s.codeReview);
  const review = useCodeReviewContinueStore((s) => s.review);
  const resetReview = useCodeReviewContinueStore((s) => s.resetReview);

  const startReview = useCallback(async () => {
    if (!repoPath) return;

    try {
      await startCodeReview(repoPath, {
        provider: codeReviewSettings.provider,
        model: codeReviewSettings.model,
        reasoningEffort: codeReviewSettings.reasoningEffort,
        bare: codeReviewSettings.bare,
        claudeEffort: codeReviewSettings.claudeEffort,
        language: codeReviewSettings.language ?? '中文',
        prompt: codeReviewSettings.prompt,
      });
    } catch (err) {
      if (err instanceof CodeReviewBusyError) {
        toastManager.add({
          title: t('Another repository is being reviewed'),
          description: t(
            'Wait for the running review to finish, or switch to that repository to manage it.'
          ),
          type: 'warning',
          timeout: 4000,
        });
        return;
      }
      throw err;
    }
  }, [
    repoPath,
    codeReviewSettings.provider,
    codeReviewSettings.model,
    codeReviewSettings.reasoningEffort,
    codeReviewSettings.bare,
    codeReviewSettings.claudeEffort,
    codeReviewSettings.language,
    codeReviewSettings.prompt,
    t,
  ]);

  return {
    content: review.content,
    status: review.status,
    error: review.error,
    startReview,
    stopReview: stopCodeReview,
    reset: resetReview,
  };
}

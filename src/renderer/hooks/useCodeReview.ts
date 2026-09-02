import { useCallback } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import {
  CodeReviewBusyError,
  startCodeReview,
  stopCodeReview,
  useCodeReviewStore,
} from '@/stores/codeReview';
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
  const review = useCodeReviewStore((s) => s.review);
  const resetReview = useCodeReviewStore((s) => s.resetReview);

  const startReview = useCallback(async () => {
    if (!repoPath) return;

    try {
      await startCodeReview(repoPath, {
        model: codeReviewSettings.model,
        effort: codeReviewSettings.effort,
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
    codeReviewSettings.model,
    codeReviewSettings.effort,
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

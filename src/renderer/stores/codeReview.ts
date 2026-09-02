import { create } from 'zustand';
import { uniqueId } from '@/lib/uniqueId';

export type ReviewStatus = 'idle' | 'initializing' | 'streaming' | 'complete' | 'error';

interface CodeReviewState {
  content: string;
  status: ReviewStatus;
  error: string | null;
  repoPath: string | null;
  reviewId: string | null;
}

interface CodeReviewStore {
  isMinimized: boolean;
  review: CodeReviewState;
  minimize: () => void;
  restore: () => void;
  updateReview: (partial: Partial<CodeReviewState>) => void;
  appendContent: (text: string) => void;
  resetReview: () => void;
  setReviewId: (reviewId: string | null) => void;
}

const initialReviewState: CodeReviewState = {
  content: '',
  status: 'idle',
  error: null,
  repoPath: null,
  reviewId: null,
};

export const useCodeReviewStore = create<CodeReviewStore>((set) => ({
  isMinimized: false,
  review: { ...initialReviewState },
  minimize: () => set({ isMinimized: true }),
  restore: () => set({ isMinimized: false }),
  updateReview: (partial) => set((state) => ({ review: { ...state.review, ...partial } })),
  appendContent: (text) =>
    set((state) => ({ review: { ...state.review, content: state.review.content + text } })),
  resetReview: () => set({ review: { ...initialReviewState }, isMinimized: false }),
  setReviewId: (reviewId) => set((state) => ({ review: { ...state.review, reviewId } })),
}));

let cleanupFn: (() => void) | null = null;

export class CodeReviewBusyError extends Error {
  constructor(public readonly busyRepoPath: string) {
    super(`Code review already running for ${busyRepoPath}`);
    this.name = 'CodeReviewBusyError';
  }
}

export async function startCodeReview(
  repoPath: string,
  settings: { model?: string; effort?: string; language: string; prompt?: string }
): Promise<void> {
  const store = useCodeReviewStore.getState();
  const current = store.review;
  if (
    (current.status === 'initializing' || current.status === 'streaming') &&
    current.repoPath !== repoPath
  ) {
    throw new CodeReviewBusyError(current.repoPath ?? repoPath);
  }
  store.setReviewId(null);
  store.updateReview({ content: '', status: 'initializing', error: null, repoPath });
  cleanupFn?.();
  cleanupFn = null;
  const reviewId = uniqueId('review');
  store.setReviewId(reviewId);
  const onDataCleanup = window.electronAPI.git.onCodeReviewData((event) => {
    if (event.reviewId !== reviewId || useCodeReviewStore.getState().review.reviewId !== reviewId)
      return;
    if (event.type === 'data' && event.data) {
      store.updateReview({ status: 'streaming' });
      store.appendContent(event.data);
    } else if (event.type === 'error' && event.data) {
      store.updateReview({ status: 'error', error: event.data });
    } else if (event.type === 'exit') {
      const status = useCodeReviewStore.getState().review.status;
      store.updateReview(
        event.exitCode !== 0 && status !== 'complete'
          ? { status: 'error', error: `Process exited with code ${event.exitCode}` }
          : { status: 'complete' }
      );
    }
  });
  cleanupFn = onDataCleanup;
  try {
    const result = await window.electronAPI.git.startCodeReview(repoPath, {
      model: settings.model,
      effort: settings.effort,
      language: settings.language,
      reviewId,
      prompt: settings.prompt,
    });
    if (!result.success) {
      store.updateReview({ status: 'error', error: result.error || 'Failed to start review' });
      stopCodeReview();
    }
  } catch (error) {
    store.updateReview({
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to start review',
    });
    stopCodeReview();
  }
}

export function stopCodeReview(): void {
  const store = useCodeReviewStore.getState();
  const reviewId = store.review.reviewId;
  cleanupFn?.();
  cleanupFn = null;
  if (reviewId) void window.electronAPI.git.stopCodeReview(reviewId);
  store.setReviewId(null);
  store.updateReview({ status: 'idle' });
}

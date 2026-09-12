/**
 * P5-2-3 — the `browser_preview` tool's other end: one preview, asked as an event.
 *
 * The third member of the family `permissionPrompt.ts` and `questionPrompt.ts`
 * started, and deliberately the same shape: a tool call parks, the host does
 * something outside the runtime, one RPC settles the promise exactly once, and
 * everything that can end a turn has to be able to settle it too.
 *
 * What is different is who answers. A permission and a question go to a person;
 * a preview goes to Electron Main, which owns the window. Nothing about the
 * runtime changes for that — it emits, it waits, it gets an answer — but it
 * means the failure the model must be able to read is a host failure ("this
 * build has no preview surface", "Chromium refused the file"), not a refusal.
 *
 * Aborting is a failure here, not a cancellation. `browser_preview` has no
 * useful "never mind" result: the model called it to put something on screen,
 * and telling it the preview was cancelled while returning success would leave
 * it believing a window exists that does not.
 */

import { randomUUID } from 'node:crypto';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { PreviewHost } from '../plugins/tools/browserPreview.ts';

export interface PreviewPromptOptions {
  sessionId: string;
  emit: (event: RuntimeEventDraft) => void;
}

/** Main's answer to one request. */
export interface PreviewResponse {
  previewId: string;
  ok: boolean;
  error?: string;
}

export interface PreviewPrompt {
  preview: PreviewHost;
  /** `false` when nothing was waiting on that id — see the RPC result's doc. */
  respond: (input: PreviewResponse) => boolean;
  /** Settle everything still parked, e.g. on dispose. All become failures. */
  drain: (reason: 'session_closed' | 'aborted') => void;
}

const DRAIN_REASONS: Record<'session_closed' | 'aborted', string> = {
  session_closed: 'the session closed before the preview opened',
  aborted: 'the turn was stopped before the preview opened',
};

export function createPreviewPrompt(options: PreviewPromptOptions): PreviewPrompt {
  const pending = new Map<string, (response: PreviewResponse) => void>();

  return {
    preview: (request, signal) =>
      new Promise<void>((resolve, reject) => {
        const previewId = randomUUID();
        options.emit({
          type: 'preview.requested',
          sessionId: options.sessionId,
          payload: { previewId, path: request.path, focus: request.focus },
        });

        let settled = false;
        const settle = (response: PreviewResponse) => {
          if (settled) return;
          settled = true;
          pending.delete(previewId);
          signal?.removeEventListener('abort', onAbort);
          if (response.ok) resolve();
          else reject(new Error(response.error ?? 'the host could not show this preview'));
        };
        function onAbort() {
          settle({ previewId, ok: false, error: DRAIN_REASONS.aborted });
        }
        if (signal?.aborted) {
          settle({ previewId, ok: false, error: DRAIN_REASONS.aborted });
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(previewId, settle);
      }),

    respond: (response) => {
      const settle = pending.get(response.previewId);
      if (!settle) return false;
      settle(response);
      return true;
    },

    drain: (reason) => {
      // Copied first: settling deletes from the map being walked.
      for (const [previewId, settle] of [...pending]) {
        settle({ previewId, ok: false, error: DRAIN_REASONS[reason] });
      }
    },
  };
}

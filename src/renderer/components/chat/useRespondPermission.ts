/**
 * Answering a permission request — the one place the app does it.
 *
 * This is the other half of `permission.requested`: the runtime parks the tool
 * call until a reply lands, and sending that reply is all this does. The card's
 * own appearance is NOT updated from here — it comes from the
 * `permission.resolved` the worker emits, so a decision made in one window is
 * reflected in every other view of the same session.
 *
 * ## Why it is a hook and not a method on the card
 *
 * It used to be a `useCallback` inside `MessageTimeline`, back when the
 * answerable card rendered in block position. The live card now lives in
 * `PendingPermissionDock`, and a second copy of this — with its own idea of
 * what a failed IPC means — is exactly the kind of drift that ends with one
 * surface treating a rejected call as success.
 *
 * ## The `false` contract, which callers depend on
 *
 * A transport failure resolves `false` rather than throwing. `QuestionCard`
 * reads that as "not answered" and unlocks its buttons, so the user can press
 * again; throwing would leave the card submitted-forever. It is also the right
 * answer for a gate that timed out while the card was on screen — the reply had
 * nowhere to go.
 */

import type { PermissionDecisionId } from '@shared/types/runtimeEvents';
import { useCallback } from 'react';

export type RespondPermission = (
  permissionId: string,
  allow: boolean,
  decision?: PermissionDecisionId
) => Promise<boolean>;

export function useRespondPermission(sessionId: string | null): RespondPermission {
  return useCallback(
    async (permissionId: string, allow: boolean, decision?: PermissionDecisionId) => {
      if (!sessionId) return false;
      try {
        const result = await window.electronAPI.chat.respondPermission({
          sessionId,
          // `allow` is the historical two-button answer; a card that offers the
          // richer set sends which button it was, and that wins.
          decision: decision ?? (allow ? 'allow' : 'deny'),
          permissionId,
        });
        return result.handled;
      } catch {
        return false;
      }
    },
    [sessionId]
  );
}

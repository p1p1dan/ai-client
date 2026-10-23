/**
 * The composer's place while the turn waits on the user (2026-10-14 user
 * decision): a live question, permission or plan review replaces the message
 * box until it is answered, or until Esc interrupts the turn.
 *
 * The composer stays mounted underneath, only hidden, so a half-typed draft,
 * its attachments and its send bookkeeping all survive the card. Permissions
 * go first: the engine is blocked on that one call, and a question cannot be
 * raised past it.
 *
 * Messages the user queued before the card came up wait for it: the queue only
 * releases on an idle session (`decideQueueRelease`), and a waiting one is not.
 */

import type React from 'react';
import { useRemoteController } from '@/stores/sessionControl';
import { requestComposerStop } from './composerFocus';
import { PendingPermissionDock, useHasPendingPermissionCard } from './PendingPermissionDock';
import { PendingQuestionDock, useHasPendingQuestionCard } from './PendingQuestionDock';
import { ReadingColumn } from './ReadingColumn';

export function usePendingInteraction(sessionId: string | null): boolean {
  const permission = useHasPendingPermissionCard(sessionId);
  const question = useHasPendingQuestionCard(sessionId);
  return permission || question;
}

export function PendingInteractionSlot({ sessionId }: { sessionId: string | null }) {
  const permission = useHasPendingPermissionCard(sessionId);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    // An open popup (a tooltip, a menu) owns its own Esc.
    if (event.defaultPrevented) return;
    event.preventDefault();
    requestComposerStop(sessionId);
  };
  // Plugin-system §4: used on a plugin's client, the card stays readable but
  // is answered there (or here after taking over), so it is inert here.
  const usedElsewhere = useRemoteController(sessionId) !== undefined;
  return (
    <div
      onKeyDown={onKeyDown}
      inert={usedElsewhere}
      className={usedElsewhere ? 'opacity-60' : undefined}
    >
      <ReadingColumn className="flex flex-col">
        {permission ? (
          <PendingPermissionDock sessionId={sessionId} />
        ) : (
          <PendingQuestionDock sessionId={sessionId} />
        )}
      </ReadingColumn>
    </div>
  );
}

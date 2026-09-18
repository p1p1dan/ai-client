/**
 * Where a live permission request is answered.
 *
 * Same shape, and the same reasons, as `PendingQuestionDock` next door — read
 * that file's header first; this one only records what is different about
 * permissions.
 *
 * ## What this replaces (2026-09-18, user report)
 *
 * The answerable permission card used to render in BLOCK POSITION inside the
 * timeline. With several requests in one turn that produced a column of cards,
 * all of them on screen at once, and the user answered them top to bottom:
 * 「顺序输出在页面上显示全部授权卡片，然后点击上面的授权后，再去后续的挨个选择」.
 * The ruling was a floating single card above the composer, one request at a
 * time, with the queue's own progress on it.
 *
 * Two halves make that true, and this is only the second one. The runtime's
 * permission gate serializes the requests themselves (`plugins/permissions`):
 * at most one is ever in the "card raised, clock running" state, and the ones
 * behind it emit no event and start no 120-second timer. So this dock is not
 * picking one card out of many to show — by the time the renderer sees them
 * there is only one.
 *
 * ## Why the progress marker cannot be counted here
 *
 * `pendingPermissions.length` is the obvious source and it is the wrong one:
 * serialization means that array holds at most one entry per session, so
 * counting it would report `1/1` forever. The numbers come from the gate, on
 * the event (`queuePosition` / `queueDepth`), and are carried on the queue
 * entry rather than on the block — see `PendingPermission` in the store for why
 * transcript is the wrong home for them.
 *
 * ## Why not a modal
 *
 * A dialog would cover the conversation the decision is about, and would take
 * the composer with it. Docked above the composer the card is unmissable and
 * everything behind it stays readable and usable.
 */

import { useChatSessionsStore } from '../../stores/chatSessions';
import { QuestionCard } from './QuestionCard';
import { derivePermissionQueueProgress, permissionDecisionAllows } from './questionCardModel';
import { useRespondPermission } from './useRespondPermission';

export function PendingPermissionDock({ sessionId }: { sessionId: string | null }) {
  // The OLDEST entry still parked on this session. Returning the parked entry
  // itself (or the null literal) keeps the selector referentially stable across
  // unrelated store writes.
  const pending = useChatSessionsStore(
    (state) => state.pendingPermissions.find((item) => item.sessionId === sessionId) ?? null
  );
  const block = useChatSessionsStore((state) => {
    if (!pending || !sessionId) return undefined;
    const message = state.messages[sessionId]?.find((item) => item.id === pending.messageId);
    return message?.blocks.find(
      (item) => item.type === 'permission_request' && item.permissionId === pending.permissionId
    );
  });
  const respondPermission = useRespondPermission(sessionId);

  // A queue entry with no block is a real intermediate state rather than a bug:
  // the same reducer pass writes both, but a reload can drop the bucket while
  // the id survives.
  if (!pending || !block) return null;
  // Belt and braces with the store: `permission.resolved` clears the queue entry
  // and freezes the block in one pass, and whichever half a subscriber sees
  // first, a settled request must not linger here answerable.
  if (block.resolved === true) return null;

  return (
    <div className="min-w-0 shrink-0 px-2 pb-2 sm:px-6">
      <div className="mx-auto w-full max-w-reading">
        <QuestionCard
          variant="permission"
          block={block}
          // True by construction: this dock renders the HEAD of the session's
          // queue and nothing else, which is precisely the entry
          // `canRespondToPermission` admits. Re-deriving it here would subscribe
          // to the whole array to recompute a constant.
          canRespond
          progress={derivePermissionQueueProgress(pending)}
          // The one place `allow` is derived from the decision (spec §3.2):
          // downstream the two travel together, so a card that says Allowed
          // cannot sit on top of a wire reply that declined.
          onRespondPermission={(decision) =>
            respondPermission(pending.permissionId, permissionDecisionAllows(decision), decision)
          }
        />
      </div>
    </div>
  );
}

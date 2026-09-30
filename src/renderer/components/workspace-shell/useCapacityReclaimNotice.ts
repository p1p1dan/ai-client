/**
 * D12 (U24) decision three: say it once when the pool reclaims a conversation.
 *
 * Reclamation itself is old behaviour and stays exactly as it was — the oldest
 * IDLE session loses its worker so a new one can start. What changed is that it
 * used to be silent, which left the user with a conversation that had quietly
 * stopped being started and nothing to attribute it to.
 *
 * The user chose "reclaim and say so" over "ask which one to give up": the real
 * cost of reclamation is one resume on the next open (a pi session lives in a
 * file, so nothing is lost but the load time), and turning that into a required
 * decision would interrupt every new chat once the pool is full.
 *
 * dsh-rebase P1-3c adds the other disconnect the user did not ask for:
 * `engine_restarted`, when Main restarted the shared DSH engine (Stop ladder B,
 * or the locked card's "Restart engine"). Every session on it goes at once, so
 * that one is said once per restart, not once per session.
 *
 * A hook rather than a reducer branch: `addToast` is a side effect, and the
 * store's event reducer is pure. The reducer's half of this (dropping the host
 * binding) lives there; the sentence lives here.
 */
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { useEffect, useRef } from 'react';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { addToast, toastManager } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';

/** One engine restart reaches every session within this span; one notice covers them all. */
const ENGINE_RESTART_NOTICE_WINDOW_MS = 5_000;

/**
 * dsh-rebase P1-7e (problem 11, decision 142): what each session had under
 * way the last time it said so — a turn (any busy `session.status`, a goal
 * round and a job's wake-up included) or a running background job. Read
 * when the pool reclaims a session: only then does 「已停止运行」 say
 * something true. Kept from the events themselves, so it does not matter
 * whether the session store has already folded the disconnect.
 */
export interface SessionWork {
  turn: boolean;
  jobs: boolean;
}

const BUSY_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'waiting_permission',
  'waiting_question',
  'stopping',
]);

/** The record after `event`; the same map when the event says nothing about work. */
export function noteSessionWork(
  work: ReadonlyMap<string, SessionWork>,
  event: RuntimeEvent
): ReadonlyMap<string, SessionWork> {
  const sessionId = event.sessionId;
  if (!sessionId) return work;
  const current = work.get(sessionId) ?? { turn: false, jobs: false };
  let next: SessionWork | undefined;
  if (event.type === 'session.status' && event.payload.status !== 'disconnected') {
    next = { ...current, turn: BUSY_STATUSES.has(event.payload.status) };
  } else if (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.stopped'
  ) {
    next = { ...current, turn: false };
  } else if (event.type === 'session.projection' && event.payload.key === 'jobs') {
    const jobs = Array.isArray(event.payload.view) ? event.payload.view : [];
    next = {
      ...current,
      jobs: jobs.some((job) => job.status === 'running' || job.status === 'stopping'),
    };
  }
  if (!next || (next.turn === current.turn && next.jobs === current.jobs)) return work;
  const updated = new Map(work);
  updated.set(sessionId, next);
  return updated;
}

/**
 * The reclaim toast. A session that had nothing under way lost nothing but
 * its engine connection — it is not 「已停止运行」; one that was working was
 * stopped, and says so.
 */
export function capacityReclaimCopy(
  input: { name?: string; working: boolean },
  t: TFunction
): { title: string; description: string } {
  const title = t('A conversation moved to the background');
  if (input.working) {
    return {
      title,
      description:
        input.name !== undefined
          ? t('“{{name}}” was stopped to make room for a new one. Open it to continue.', {
              name: input.name,
            })
          : t('An older conversation was stopped to make room for a new one.'),
    };
  }
  return {
    title,
    description:
      input.name !== undefined
        ? t(
            '“{{name}}” was idle and moved to the background to make room for a new one. Nothing is lost; open it to continue.',
            { name: input.name }
          )
        : t(
            'An idle older conversation moved to the background to make room for a new one. Nothing is lost.'
          ),
  };
}

export function useCapacityReclaimNotice(): void {
  const { t } = useI18n();
  const lastEngineRestartNoticeAt = useRef(0);
  const work = useRef<ReadonlyMap<string, SessionWork>>(new Map());
  /** The reclaim toast on screen, if any: a second reclaim replaces it rather than stacking. */
  const reclaimToastId = useRef<string | null>(null);

  useEffect(() => {
    return subscribeRuntimeEvent((event) => {
      const before = work.current;
      work.current = noteSessionWork(before, event);
      if (event.type !== 'session.status') return;
      if (event.payload.disconnectReason === 'engine_restarted') {
        const now = Date.now();
        if (now - lastEngineRestartNoticeAt.current < ENGINE_RESTART_NOTICE_WINDOW_MS) return;
        lastEngineRestartNoticeAt.current = now;
        addToast({
          type: 'info',
          title: t('The chat engine was restarted'),
          description: t(
            'Your chats reconnect by themselves. A reply that was running was interrupted; you can continue it in its chat.'
          ),
        });
        return;
      }
      if (event.payload.disconnectReason !== 'capacity_reclaimed') return;
      // Read the title fresh at event time rather than subscribing to the
      // session list: this effect must not re-subscribe on every store change,
      // and the title it wants is whatever the row says right now.
      const session = useChatSessionsStore
        .getState()
        .sessions.find((item) => item.id === event.sessionId);
      // What the session had under way BEFORE this event.
      const had = before.get(event.sessionId);
      const copy = capacityReclaimCopy(
        {
          ...(session ? { name: displaySessionTitle(session.title, t) } : {}),
          working: had?.turn === true || had?.jobs === true,
        },
        t
      );
      // Each new chat past the pool's size reclaims one: one toast says the
      // latest, instead of a pile of them over the composer (P1-7e).
      if (reclaimToastId.current) toastManager.close(reclaimToastId.current);
      reclaimToastId.current = addToast({ type: 'info', ...copy });
    });
  }, [t]);
}
